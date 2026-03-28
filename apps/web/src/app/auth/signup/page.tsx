'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sly/ui';
import { Loader2, Zap, Send, Bot, User, ChevronDown, ChevronUp } from 'lucide-react';
import Link from 'next/link';
import { OAuthButtons } from '@/components/auth/oauth-buttons';

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

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [inviteCode, setInviteCode] = useState(initialCode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [mode, setMode] = useState<'signup' | 'apply'>(initialCode ? 'signup' : (isClosedBeta ? 'apply' : 'signup'));

  // Application form state
  const [useCase, setUseCase] = useState('');
  const [referralSource, setReferralSource] = useState('');
  const [applicationSubmitted, setApplicationSubmitted] = useState(false);

  // Agent application state
  const [applicantType, setApplicantType] = useState<'human' | 'agent'>(
    searchParams.get('type') === 'agent' ? 'agent' : 'human'
  );
  const [agentName, setAgentName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [model, setModel] = useState('');
  const [showApiDocs, setShowApiDocs] = useState(false);

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/v1/auth/beta/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          ...(applicantType === 'agent'
            ? {
                applicantType: 'agent',
                agentName: agentName || undefined,
                purpose: purpose || undefined,
                model: model || undefined,
              }
            : {
                organizationName: organizationName || undefined,
                useCase: useCase || undefined,
              }),
          referralSource: referralSource || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Failed to submit application');
        setLoading(false);
        return;
      }

      setApplicationSubmitted(true);
    } catch {
      setError('Could not connect to the server. Please try again.');
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

    if (!organizationName.trim()) {
      setError('Organization name is required');
      setLoading(false);
      return;
    }

    // If closed beta, validate invite code first
    if (isClosedBeta && inviteCode) {
      try {
        const validateRes = await fetch(`${apiUrl}/v1/auth/beta/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: inviteCode }),
        });
        const validateJson = await validateRes.json();
        const validateData = validateJson.data || validateJson;
        if (!validateData.valid) {
          setError(validateData.error || validateJson.error || 'Invalid invite code');
          setLoading(false);
          return;
        }
      } catch {
        setError('Could not validate invite code. Please try again.');
        setLoading(false);
        return;
      }
    }

    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/auth/setup`,
        data: {
          organization_name: organizationName.trim(),
          name: email.split('@')[0],
          ...(isClosedBeta && inviteCode ? { invite_code: inviteCode } : {}),
        },
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  }

  // Application submitted confirmation
  if (applicationSubmitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3">
                <Send className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">Application received</CardTitle>
            <CardDescription>
              {applicantType === 'agent'
                ? "Thanks for registering your agent! We'll review it and email you when access is ready."
                : 'Thanks for applying! We review applications on a rolling basis and will email you when your access is ready.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/auth/login">Back to Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Email confirmation success
  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-green-100 dark:bg-green-900/20 p-3">
                <Zap className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">Check your email</CardTitle>
            <CardDescription>
              We've sent you a confirmation link. Please check your email to complete signup.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/auth/login">Back to Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Application form (closed beta, no invite code)
  if (mode === 'apply') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-primary/10 p-3">
                <Zap className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">Apply for Early Access</CardTitle>
            <CardDescription>
              Sly is currently in closed beta. Apply below or enter an invite code.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Human / Agent toggle */}
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                onClick={() => setApplicantType('human')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-md border transition-colors ${
                  applicantType === 'human'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
              >
                <User className="h-4 w-4" />
                I&apos;m a person
              </button>
              <button
                type="button"
                onClick={() => setApplicantType('agent')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-md border transition-colors ${
                  applicantType === 'agent'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
              >
                <Bot className="h-4 w-4" />
                I&apos;m registering an agent
              </button>
            </div>

            <form onSubmit={handleApply} className="space-y-4">
              {error && (
                <div className="p-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
                  {error}
                </div>
              )}

              {applicantType === 'agent' ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="agentName">Agent Name</Label>
                    <Input
                      id="agentName"
                      type="text"
                      placeholder="My Payment Agent"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Contact Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="dev@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="purpose">Purpose <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <textarea
                      id="purpose"
                      placeholder="What does your agent do?"
                      value={purpose}
                      onChange={(e) => setPurpose(e.target.value)}
                      className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="model">Model <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <Input
                      id="model"
                      type="text"
                      placeholder="e.g. Claude, GPT-4"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <>
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
                    <Label htmlFor="organizationName">Organization Name <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <Input
                      id="organizationName"
                      type="text"
                      placeholder="Acme Inc."
                      value={organizationName}
                      onChange={(e) => setOrganizationName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="useCase">What will you use Sly for? <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <textarea
                      id="useCase"
                      placeholder="Tell us about your use case..."
                      value={useCase}
                      onChange={(e) => setUseCase(e.target.value)}
                      className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-20"
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="referralSource">How did you hear about us? <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  id="referralSource"
                  type="text"
                  placeholder="Twitter, friend, etc."
                  value={referralSource}
                  onChange={(e) => setReferralSource(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {applicantType === 'agent' ? 'Register Agent' : 'Apply for Access'}
              </Button>
            </form>

            {/* Programmatic access docs for agent applicants */}
            {applicantType === 'agent' && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setShowApiDocs(!showApiDocs)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showApiDocs ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  Programmatic access
                </button>
                {showApiDocs && (
                  <div className="mt-2 p-3 text-xs font-mono bg-muted rounded-md space-y-2 overflow-x-auto">
                    <p className="text-muted-foreground font-sans text-xs">For programmatic access, POST to:</p>
                    <pre className="whitespace-pre-wrap">{`POST ${apiUrl}/v1/auth/beta/apply
Content-Type: application/json

{
  "applicantType": "agent",
  "agentName": "Your Agent",
  "email": "dev@example.com",
  "purpose": "What your agent does",
  "model": "Claude"
}`}</pre>
                    <p className="text-muted-foreground font-sans text-xs mt-2">
                      Also discoverable via A2A:{' '}
                      <code className="text-xs">GET {apiUrl}/.well-known/agent.json</code>
                      {' '}&rarr; skill &quot;apply_for_beta&quot;
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">have an invite code?</span>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full"
              onClick={() => setMode('signup')}
            >
              Sign up with invite code
            </Button>

            <div className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link href="/auth/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Normal signup form (with optional invite code field in closed beta)
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="rounded-full bg-primary/10 p-3">
              <Zap className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold">Create an account</CardTitle>
          <CardDescription>
            Get started with Sly Dashboard
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                  type="text"
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
                type="text"
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

          {!isClosedBeta && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>

              <OAuthButtons mode="signup" />
            </>
          )}

          {isClosedBeta && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">no code?</span>
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setMode('apply')}
              >
                Apply for early access
              </Button>
            </>
          )}

          <div className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link href="/auth/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
