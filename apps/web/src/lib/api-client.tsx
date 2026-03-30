'use client';

import { createContext, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PayOSClient, createPayOSClient, PayOSError } from '@sly/api-client';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useEnvironment } from '@/lib/environment-context';

interface ApiClientContextType {
  client: PayOSClient | null;
  apiKey: string | null;
  setApiKey: (key: string | null) => void;
  isConfigured: boolean;
  isLoading: boolean;
  authToken: string | null;
}

const ApiClientContext = createContext<ApiClientContextType>({
  client: null,
  apiKey: null,
  setApiKey: () => {},
  isConfigured: false,
  isLoading: true,
  authToken: null,
});

const API_KEY_STORAGE_KEY = 'payos_api_key';

export function ApiClientProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKeyState] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const queryClient = useQueryClient();
  const { apiEnvironment } = useEnvironment();

  // Load API key from localStorage AND get JWT from Supabase session
  useEffect(() => {
    async function initialize() {
      // Check for stored API key (for programmatic access)
      const storedApiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
      if (storedApiKey) {
        setApiKeyState(storedApiKey);
      }

      // Get JWT token from Supabase session (for dashboard access)
      const supabase = createSupabaseBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (session?.access_token) {
        setAuthToken(session.access_token);
      }

      // Listen for auth changes
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        setAuthToken(session?.access_token || null);
        // Clear all cached queries on sign-out to prevent cross-tenant data leakage
        if (event === 'SIGNED_OUT') {
          queryClient.clear();
        }
      });

      setIsInitialized(true);

      return () => {
        subscription.unsubscribe();
      };
    }

    initialize();
  }, [queryClient]);

  // Save API key to localStorage when it changes
  const setApiKey = (key: string | null) => {
    if (key) {
      localStorage.setItem(API_KEY_STORAGE_KEY, key);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
    setApiKeyState(key);
  };

  // Create client instance with JWT token (preferred) or API key (fallback)
  const client = useMemo(() => {
    // Prefer JWT from session for dashboard access
    const token = authToken || apiKey;
    if (!token) return null;
    
    // Route to the correct API server based on environment
    const sandboxUrl = process.env.NEXT_PUBLIC_SANDBOX_API_URL;
    const productionUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const baseUrl = apiEnvironment === 'live' ? productionUrl : (sandboxUrl || productionUrl);

    return createPayOSClient({
      baseUrl,
      apiKey: token,
      defaultHeaders: { 'X-Environment': apiEnvironment },
      onError: (error) => {
        console.error('API Error:', error);
        
        // Handle 429 Rate Limiting
        if (error.status === 429) {
          const retryAfter = error.retryAfter || 60;
          toast.error('Too Many Requests', {
            description: `Please wait ${retryAfter} seconds before trying again.`,
            duration: retryAfter * 1000, // Show toast for the retry duration
            action: {
              label: 'Dismiss',
              onClick: () => {},
            },
          });
          return;
        }
        
        // Handle 401 - if using API key, clear it
        if (error.status === 401) {
          if (apiKey) {
            setApiKey(null);
            toast.error('Invalid API Key', {
              description: 'Your API key is invalid or expired. Please re-enter it.',
            });
          }
          // If using JWT, Supabase will handle re-auth
          return;
        }
        
        // Generic error toast for other errors (don't show for validation errors)
        if (error.status >= 500) {
          toast.error('Server Error', {
            description: error.message || 'An unexpected error occurred. Please try again.',
          });
        }
      },
    });
  }, [authToken, apiKey, apiEnvironment]);

  const value = {
    client,
    apiKey,
    setApiKey,
    isConfigured: isInitialized && (!!authToken || !!apiKey), // Configured if we have either JWT or API key
    isLoading: !isInitialized,
    authToken,
  };

  return (
    <ApiClientContext.Provider value={value}>
      {children}
    </ApiClientContext.Provider>
  );
}

export function useApiClient() {
  const context = useContext(ApiClientContext);
  return context.client;
}

export function useApiConfig() {
  const context = useContext(ApiClientContext);
  const { apiEnvironment } = useEnvironment();
  const sandboxUrl = process.env.NEXT_PUBLIC_SANDBOX_API_URL;
  const productionUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  const apiUrl = apiEnvironment === 'live' ? productionUrl : (sandboxUrl || productionUrl);
  return {
    apiKey: context.apiKey,
    setApiKey: context.setApiKey,
    isConfigured: context.isConfigured,
    isLoading: context.isLoading,
    authToken: context.authToken,
    apiEnvironment,
    apiUrl,
  };
}

/** Fetch-compatible function signature returned by useApiFetch. */
export type ApiFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Returns a fetch wrapper that includes Authorization and X-Environment headers.
 * Use this instead of raw fetch() for API calls in dashboard components.
 */
export function useApiFetch(): ApiFetchFn {
  const { authToken } = useApiConfig();
  const { apiEnvironment } = useEnvironment();

  return useMemo(() => {
    return (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
      headers.set('X-Environment', apiEnvironment);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      return fetch(url, { ...init, headers });
    };
  }, [authToken, apiEnvironment]);
}

