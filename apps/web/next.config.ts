import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Enable React strict mode for better development experience
  reactStrictMode: true,

  // Environment variables exposed to the browser.
  // In HTTPS dev mode the browser refuses cross-origin/mixed calls to
  // http://localhost:4000, so we set NEXT_PUBLIC_API_URL to '' (relative)
  // and proxy /v1/* + /webhooks/* through Next's rewrites below.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? '',
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  },

  // Same-origin proxy for the Hono API. Lets the HTTPS web app talk to
  // the HTTP API without tripping mixed-content / CORS in the browser.
  async rewrites() {
    const apiTarget = process.env.API_URL || 'http://localhost:4000';
    return [
      { source: '/v1/:path*', destination: `${apiTarget}/v1/:path*` },
      { source: '/webhooks/:path*', destination: `${apiTarget}/webhooks/:path*` },
    ];
  },

  // Transpile workspace packages
  transpilePackages: ['@sly/api-client', '@sly/types', '@sly/ui'],

  // Experimental features
  experimental: {
    // Enable server actions
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

export default nextConfig;

