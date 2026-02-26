import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error, data } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) {
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
          // Response may be wrapped as { data: { user, tenant } }
          const me = meData.data || meData;
          if (!me.tenant) {
            // No tenant — redirect to setup
            return NextResponse.redirect(`${origin}/auth/setup`);
          }
        } else {
          // API error — redirect to setup as fallback
          return NextResponse.redirect(`${origin}/auth/setup`);
        }
      } catch {
        // API unreachable — redirect to setup as fallback
        return NextResponse.redirect(`${origin}/auth/setup`);
      }

      // User has tenant — proceed to requested page
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Return to login with error
  return NextResponse.redirect(`${origin}/auth/login?error=Could not authenticate`);
}

