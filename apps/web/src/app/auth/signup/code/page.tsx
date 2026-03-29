'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@sly/ui';
import { Input } from '@sly/ui';
import { Label } from '@sly/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@sly/ui';
import { Loader2, Zap, AlertCircle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';

const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function CodeSignUpPage() {
  return (
    <Suspense>
      <CodeSignUpPageInner />
    </Suspense>
  );
}

function CodeSignUpPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams.get('code') || '';

  const [inviteCode, setInviteCode] = useState(code);
  const [codeValid, setCodeValid] = useState<boolean | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Auto-validate code from URL
  useEffect(() => {
    if (code) {
      validateCode(code);
    }
  }, [code]);

  async function validateCode(codeToValidate: string) {
    setValidating(true);
    setCodeError(null);
    setCodeValid(null);

    try {
      const response = await fetch(`${apiUrl}/v1/auth/beta/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeToValidate }),
      });

      const json = await response.json();
      // API returns { success, data: { valid, applicant } } or { valid } (legacy)
      const result = json.data || json;
      setCodeValid(result.valid);
      if (!result.valid) {
        setCodeError(result.error || json.error || 'Invalid invite code');
      } else if (result.applicant) {
        // Pre-fill from application data
        if (result.applicant.email) setEmail(result.applicant.email);
        if (result.applicant.organization_name) setOrganizationName(result.applicant.organization_name);
      }
    } catch {
      setCodeError('Could not validate code. Please try again.');
      setCodeValid(false);
    }
    setValidating(false);
  }

  async function handleSubmit(e: React.FormEvent) {
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

    const supabase = createSupabaseBrowserClient();
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/auth/setup`,
        data: {
          organization_name: organizationName.trim(),
          name: email.split('@')[0],
          invite_code: inviteCode,
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

  // Known applicant — streamlined view
  const hasApplicant = codeValid && email;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="rounded-full bg-primary/10 p-3">
              <Zap className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold">
            {hasApplicant ? `Welcome to Sly` : 'Create your account'}
          </CardTitle>
          <CardDescription>
            {hasApplicant
              ? `Sign in as ${email} to get started`
              : 'Enter your invite code and create your Sly account'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="p-3 mb-4 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-md">
              {error}
            </div>
          )}

          {/* Validating state */}
          {validating && (
            <div className="text-center py-4">
              <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-primary" />
              <p className="text-sm text-muted-foreground">Validating invite code...</p>
            </div>
          )}

          {/* Code error */}
          {codeError && (
            <div className="text-center py-4">
              <AlertCircle className="h-6 w-6 mx-auto mb-2 text-red-500" />
              <p className="text-sm text-red-500">{codeError}</p>
            </div>
          )}

          {/* Known applicant — just show SSO + optional password */}
          {hasApplicant && !validating && (
            <div className="space-y-4">
              {/* Info card */}
              <div className="p-3 bg-muted rounded-lg text-sm space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Email</span><span>{email}</span></div>
                {organizationName && <div className="flex justify-between"><span className="text-muted-foreground">Organization</span><span>{organizationName}</span></div>}
              </div>

              {/* Google SSO — primary action */}
              <Button
                type="button"
                className="w-full"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  localStorage.setItem('sly_beta_invite_code', inviteCode);
                  localStorage.setItem('sly_beta_org_name', organizationName || '');
                  const supabase = createSupabaseBrowserClient();
                  await supabase.auth.signInWithOAuth({
                    provider: 'google',
                    options: {
                      redirectTo: `${window.location.origin}/auth/callback?next=/auth/setup&invite_code=${encodeURIComponent(inviteCode)}`,
                      queryParams: { access_type: 'offline', prompt: 'consent' },
                    },
                  });
                }}
              >
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                Continue with Google
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                <div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-2 text-muted-foreground">Or use email</span></div>
              </div>

              {/* Collapsed password form */}
              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="password">Set a password</Label>
                  <Input id="password" type="password" placeholder="Min 12 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                {password && (
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm Password</Label>
                    <Input id="confirmPassword" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                  </div>
                )}
                {password && (
                  <Button type="submit" variant="outline" className="w-full" disabled={loading || !password}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create Account with Email
                  </Button>
                )}
              </form>
            </div>
          )}

          {/* Unknown applicant — full form */}
          {!hasApplicant && codeValid && !validating && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="organizationName">Organization Name</Label>
                <Input id="organizationName" placeholder="Acme Inc." value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input id="confirmPassword" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Account
              </Button>
            </form>
          )

          {codeValid && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                <div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-2 text-muted-foreground">Or</span></div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  // Store invite code so the callback can provision the tenant
                  localStorage.setItem('sly_beta_invite_code', inviteCode);
                  localStorage.setItem('sly_beta_org_name', organizationName || '');
                  const supabase = createSupabaseBrowserClient();
                  await supabase.auth.signInWithOAuth({
                    provider: 'google',
                    options: {
                      redirectTo: `${window.location.origin}/auth/callback?next=/auth/setup&invite_code=${encodeURIComponent(inviteCode)}`,
                      queryParams: {
                        access_type: 'offline',
                        prompt: 'consent',
                      },
                    },
                  });
                }}
              >
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                Sign up with Google
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
