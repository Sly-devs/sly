import { redirect } from 'next/navigation';
import { getUser, createSupabaseServerClient } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { SidebarProvider } from '@/components/layout/sidebar-context';
import { LocaleProvider } from '@/lib/locale';
import { SidebarLayout } from '@/components/layout/sidebar-layout';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { DemoLayoutWrapper } from '@/components/demo/demo-layout-wrapper';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser();

  if (!user) {
    redirect('/auth/login');
  }

  // Tenant guard: check if user has a tenant provisioned
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:4000';
      const meResponse = await fetch(`${apiUrl}/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      if (meResponse.ok) {
        const meData = await meResponse.json();
        if (!meData.tenant) {
          redirect('/auth/setup');
        }
      }
    }
  } catch {
    // If API is unreachable, allow dashboard access — middleware handles auth
  }

  return (
    <LocaleProvider>
      <DemoLayoutWrapper>
        <SidebarProvider>
          <RealtimeProvider>
            <div className="min-h-screen bg-gray-50 dark:bg-black">
              <Sidebar />
              <SidebarLayout>
                <Header user={user} />
                <main className="flex-1">
                  {children}
                </main>
              </SidebarLayout>
            </div>
          </RealtimeProvider>
        </SidebarProvider>
      </DemoLayoutWrapper>
    </LocaleProvider>
  );
}
