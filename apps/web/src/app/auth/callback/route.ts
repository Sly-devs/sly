import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';
  const inviteCode = searchParams.get('invite_code');

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error, data } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) {
      const setupUrl = inviteCode
        ? `${origin}/auth/setup?invite_code=${encodeURIComponent(inviteCode)}`
        : `${origin}/auth/setup`;

      // Check if user has a tenant provisioned
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:4000';
        const meResponse = await fetch(`${apiUrl}/v1/auth/me`, {
          headers: {
            'Authorization': `Bearer ${data.session.access_token}`,
          },
        });

        if (meResponse.ok) {
          const meData = await meResponse.json();
          const me = meData.data || meData;
          if (!me.tenant) {
            return NextResponse.redirect(setupUrl);
          }
        } else {
          return NextResponse.redirect(setupUrl);
        }
      } catch {
        // API unreachable — redirect to setup
        return NextResponse.redirect(setupUrl);
      }

      // User has tenant — proceed to requested page
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Return to login with error
  return NextResponse.redirect(`${origin}/auth/login?error=Could not authenticate`);
}

