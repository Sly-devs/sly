'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApiConfig } from '@/lib/api-client';

// Handler types supported by the API
export type HandlerType = 'stripe' | 'paypal' | 'circle' | 'payos_native';

// Status of a connected account
export type ConnectedAccountStatus = 'active' | 'inactive' | 'error';

// Connected account as returned by the API
export interface ConnectedAccount {
  id: string;
  handler_type: HandlerType;
  handler_name: string;
  status: ConnectedAccountStatus;
  last_verified_at: string | null;
  metadata?: Record<string, unknown>;
  connected_at: string;
  updated_at?: string;
}

// Input for creating a connected account
export interface CreateConnectedAccountInput {
  handler_type: HandlerType;
  handler_name: string;
  credentials: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Input for updating a connected account
export interface UpdateConnectedAccountInput {
  handler_name?: string;
  credentials?: Record<string, unknown>;
  status?: 'active' | 'inactive';
  metadata?: Record<string, unknown>;
}

// Verification result
export interface VerificationResult {
  verified: boolean;
  error?: string;
  account_info?: Record<string, unknown>;
}

// Handler info for UI display
export interface HandlerInfo {
  type: HandlerType;
  name: string;
  description: string;
  icon: string;
  docsUrl: string;
  docsLabel: string;
  fields: Array<{
    key: string;
    label: string;
    type: 'text' | 'password' | 'toggle';
    placeholder?: string;
    required: boolean;
    helpText?: string;
    defaultValue?: boolean;
  }>;
}

// Handler configuration for the UI
export const HANDLER_INFO: Record<HandlerType, HandlerInfo> = {
  stripe: {
    type: 'stripe',
    name: 'Stripe',
    description: 'Accept payments via Stripe',
    icon: 'stripe',
    docsUrl: 'https://dashboard.stripe.com/test/apikeys',
    docsLabel: 'Get Stripe API Keys',
    fields: [
      {
        key: 'api_key',
        label: 'Secret Key',
        type: 'password',
        placeholder: 'sk_live_... or sk_test_...',
        required: true,
        helpText: 'Your Stripe secret API key',
      },
      {
        key: 'webhook_secret',
        label: 'Webhook Secret',
        type: 'password',
        placeholder: 'whsec_...',
        required: false,
        helpText: 'Optional: For receiving Stripe webhooks',
      },
    ],
  },
  paypal: {
    type: 'paypal',
    name: 'PayPal',
    description: 'Accept PayPal payments',
    icon: 'paypal',
    docsUrl: 'https://developer.paypal.com/dashboard/applications/sandbox',
    docsLabel: 'Get PayPal Sandbox Credentials',
    fields: [
      {
        key: 'client_id',
        label: 'Client ID',
        type: 'text',
        placeholder: 'Your PayPal Client ID',
        required: true,
        helpText: 'Find this in your PayPal Developer Dashboard',
      },
      {
        key: 'client_secret',
        label: 'Client Secret',
        type: 'password',
        placeholder: 'Your PayPal Client Secret',
        required: true,
      },
      {
        key: 'sandbox',
        label: 'Sandbox Mode',
        type: 'toggle',
        required: false,
        helpText: 'Enable for testing with sandbox credentials',
        defaultValue: true,
      },
    ],
  },
  circle: {
    type: 'circle',
    name: 'Circle',
    description: 'USDC payments via Circle',
    icon: 'circle',
    docsUrl: 'https://console.circle.com/api-keys',
    docsLabel: 'Get Circle API Key',
    fields: [
      {
        key: 'api_key',
        label: 'API Key',
        type: 'password',
        placeholder: 'Your Circle API key',
        required: true,
        helpText: 'Find this in your Circle Developer Console',
      },
      {
        key: 'sandbox',
        label: 'Sandbox Mode',
        type: 'toggle',
        required: false,
        helpText: 'Enable for testing with sandbox credentials',
        defaultValue: true,
      },
    ],
  },
  payos_native: {
    type: 'payos_native',
    name: 'Sly Native',
    description: 'Native Pix/SPEI support',
    icon: 'payos',
    docsUrl: 'https://www.bcb.gov.br/estabilidadefinanceira/pix',
    docsLabel: 'Learn about Pix & SPEI',
    fields: [
      {
        key: 'pix_key',
        label: 'Pix Key (Brazil)',
        type: 'text',
        placeholder: 'CPF, CNPJ, email, phone, or random key',
        required: false,
        helpText: 'For Brazilian Pix payments',
      },
      {
        key: 'clabe',
        label: 'CLABE (Mexico)',
        type: 'text',
        placeholder: '18-digit CLABE number',
        required: false,
        helpText: 'For Mexican SPEI transfers',
      },
    ],
  },
};

export function useConnectedAccounts() {
  const { authToken, isConfigured, isLoading: authLoading, apiUrl } = useApiConfig();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Helper for making authenticated requests
  const makeRequest = useCallback(
    async <T>(
      endpoint: string,
      options: RequestInit = {}
    ): Promise<{ data?: T; error?: string }> => {
      if (!authToken) {
        return { error: 'Not authenticated' };
      }

      try {
        const response = await fetch(`${apiUrl}/v1/organization${endpoint}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            ...options.headers,
          },
        });

        const result = await response.json();

        if (!response.ok) {
          return { error: result.error || 'Request failed' };
        }

        return { data: result };
      } catch (err) {
        console.error('Request error:', err);
        return { error: 'Network error' };
      }
    },
    [authToken, apiUrl]
  );

  // Fetch all connected accounts
  const fetchAccounts = useCallback(async () => {
    if (!isConfigured || authLoading) return;

    setIsLoading(true);
    setError(null);

    const result = await makeRequest<{ data: ConnectedAccount[] }>('/connected-accounts');

    if (result.error) {
      setError(result.error);
      setAccounts([]);
    } else if (result.data) {
      setAccounts(result.data.data || []);
    }

    setIsLoading(false);
  }, [isConfigured, authLoading, makeRequest]);

  // Create a new connected account
  const connect = useCallback(
    async (input: CreateConnectedAccountInput): Promise<{ data?: ConnectedAccount; error?: string }> => {
      const result = await makeRequest<ConnectedAccount>('/connected-accounts', {
        method: 'POST',
        body: JSON.stringify(input),
      });

      if (result.data) {
        // Refresh the list
        await fetchAccounts();
      }

      return result;
    },
    [makeRequest, fetchAccounts]
  );

  // Update a connected account
  const update = useCallback(
    async (
      id: string,
      input: UpdateConnectedAccountInput
    ): Promise<{ data?: ConnectedAccount; error?: string }> => {
      const result = await makeRequest<ConnectedAccount>(`/connected-accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });

      if (result.data) {
        await fetchAccounts();
      }

      return result;
    },
    [makeRequest, fetchAccounts]
  );

  // Delete/disconnect an account
  const disconnect = useCallback(
    async (id: string): Promise<{ success?: boolean; error?: string }> => {
      const result = await makeRequest<{ message: string }>(`/connected-accounts/${id}`, {
        method: 'DELETE',
      });

      if (result.data) {
        await fetchAccounts();
        return { success: true };
      }

      return { error: result.error };
    },
    [makeRequest, fetchAccounts]
  );

  // Verify credentials for an account
  const verify = useCallback(
    async (id: string): Promise<{ data?: VerificationResult; error?: string }> => {
      const result = await makeRequest<VerificationResult>(`/connected-accounts/${id}/verify`, {
        method: 'POST',
      });

      if (result.data) {
        // Refresh to get updated status
        await fetchAccounts();
      }

      return result;
    },
    [makeRequest, fetchAccounts]
  );

  // Fetch accounts on mount
  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  return {
    accounts,
    isLoading: isLoading || authLoading,
    error,
    connect,
    update,
    disconnect,
    verify,
    refresh: fetchAccounts,
    handlerInfo: HANDLER_INFO,
  };
}
