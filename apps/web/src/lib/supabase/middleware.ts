import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: any }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session if expired
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Protected routes
  const isAuthRoute = request.nextUrl.pathname.startsWith('/auth');
  const isProtectedRoute = request.nextUrl.pathname.startsWith('/dashboard');
  const isApiRoute = request.nextUrl.pathname.startsWith('/api');

  // Don't redirect API routes
  if (isApiRoute) {
    return supabaseResponse;
  }

  // Redirect unauthenticated users from protected routes
  if (isProtectedRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/login';
    url.searchParams.set('redirect', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users from auth routes (except pages that need the session)
  const authExceptions = ['/auth/reset-password', '/auth/setup', '/auth/callback'];
  const isAuthException = authExceptions.some(path => request.nextUrl.pathname.startsWith(path));
  if (isAuthRoute && user && !isAuthException) {
    const redirect = request.nextUrl.searchParams.get('redirect') || '/dashboard';
    const url = request.nextUrl.clone();
    url.pathname = redirect;
    url.search = '';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

