import type { Metadata } from 'next';

import { Analytics } from '@vercel/analytics/react';
import { Toaster } from 'sonner';
import { ApiClientProvider } from '@/lib/api-client';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { QueryProvider } from '@/components/providers/query-provider';
import { Web3Provider } from '@/components/providers/web3-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sly Dashboard',
  description: 'Stablecoin Payout Operating System for LATAM',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased" suppressHydrationWarning>
        <ThemeProvider>
          <Web3Provider>
            <QueryProvider>
              <ApiClientProvider>
                {children}
              </ApiClientProvider>
            </QueryProvider>
          </Web3Provider>
          <Toaster position="top-right" richColors />
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
