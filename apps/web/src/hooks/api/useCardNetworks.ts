'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApiConfig } from '@/lib/api-client';

// Network types
export type CardNetworkType = 'visa' | 'mastercard';

// Status of a card network connection
export type CardNetworkStatus = 'active' | 'inactive' | 'error';

// Card network configuration as returned by the API
export interface CardNetworkConfig {
  network: CardNetworkType;
  status: CardNetworkStatus;
  sandbox: boolean;
  lastVerifiedAt?: string;
  connectedAt?: string;
}

// Input for configuring a card network
export interface ConfigureCardNetworkInput {
  api_key: string;
  shared_secret?: string;
  consumer_key?: string;
  private_key_pem?: string;
  keystore_path?: string;
  keystore_password?: string;
  sandbox: boolean;
}

// Network info for UI display
export interface CardNetworkInfo {
  network: CardNetworkType;
  name: string;
  description: string;
  docsUrl: string;
  docsLabel: string;
  fields: Array<{
    key: string;
    label: string;
    type: 'text' | 'password' | 'toggle' | 'textarea';
    placeholder?: string;
    required: boolean;
    helpText?: string;
    defaultValue?: boolean;
  }>;
}

// Network configuration for the UI
export const CARD_NETWORK_INFO: Record<CardNetworkType, CardNetworkInfo> = {
  visa: {
    network: 'visa',
    name: 'Visa Intelligent Commerce (VIC)',
    description: 'Accept Visa card payments via VIC for agentic commerce',
    docsUrl: 'https://developer.visa.com/capabilities/visa-intelligent-commerce',
    docsLabel: 'Visa VIC Documentation',
    fields: [
      {
        key: 'api_key',
        label: 'API Key',
        type: 'password',
        placeholder: 'Your Visa VIC API key',
        required: true,
        helpText: 'Find this in your Visa Developer Portal',
      },
      {
        key: 'shared_secret',
        label: 'Shared Secret',
        type: 'password',
        placeholder: 'Your Visa webhook shared secret',
        required: false,
        helpText: 'Optional: For verifying Visa webhooks',
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
  mastercard: {
    network: 'mastercard',
    name: 'Mastercard Agent Pay',
    description: 'Accept Mastercard payments via Agent Pay protocol',
    docsUrl: 'https://developer.mastercard.com/agent-pay/documentation/',
    docsLabel: 'Mastercard Agent Pay Docs',
    fields: [
      {
        key: 'consumer_key',
        label: 'Consumer Key',
        type: 'text',
        placeholder: 'Your Mastercard Consumer Key',
        required: true,
        helpText: 'Find this in your Mastercard Developer Portal',
      },
      {
        key: 'private_key_pem',
        label: 'Private Key (PEM)',
        type: 'textarea',
        placeholder: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----',
        required: false,
        helpText: 'Your RSA private key in PEM format (alternative to keystore)',
      },
      {
        key: 'keystore_path',
        label: 'Keystore Path',
        type: 'text',
        placeholder: '/path/to/keystore.p12',
        required: false,
        helpText: 'Alternative: Path to your P12 keystore file',
      },
      {
        key: 'keystore_password',
        label: 'Keystore Password',
        type: 'password',
        placeholder: 'Keystore password',
        required: false,
        helpText: 'Password for the keystore file',
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
};

export function useCardNetworks() {
  const { authToken, isConfigured, isLoading: authLoading, apiUrl } = useApiConfig();
  const [networks, setNetworks] = useState<CardNetworkConfig[]>([]);
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
        const response = await fetch(`${apiUrl}/v1/cards${endpoint}`, {
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

  // Fetch all card network configurations
  const fetchNetworks = useCallback(async () => {
    if (!isConfigured || authLoading) return;

    setIsLoading(true);
    setError(null);

    const result = await makeRequest<{ networks: CardNetworkConfig[] }>('/networks');

    if (result.error) {
      setError(result.error);
      setNetworks([]);
    } else if (result.data) {
      setNetworks(result.data.networks || []);
    }

    setIsLoading(false);
  }, [isConfigured, authLoading, makeRequest]);

  // Configure a card network
  const configure = useCallback(
    async (
      network: CardNetworkType,
      input: ConfigureCardNetworkInput
    ): Promise<{ data?: CardNetworkConfig; error?: string }> => {
      // Map the input to the correct handler type and credentials format
      const handlerType = network === 'visa' ? 'visa_vic' : 'mastercard_agent_pay';

      const credentials = network === 'visa'
        ? {
            api_key: input.api_key,
            shared_secret: input.shared_secret,
            sandbox: input.sandbox,
          }
        : {
            consumer_key: input.consumer_key,
            private_key_pem: input.private_key_pem,
            keystore_path: input.keystore_path,
            keystore_password: input.keystore_password,
            sandbox: input.sandbox,
          };

      // Use the connected accounts API to create/update the network configuration
      const result = await makeRequest<CardNetworkConfig>(
        `/networks/${network}/configure`,
        {
          method: 'POST',
          body: JSON.stringify({
            handler_type: handlerType,
            credentials,
          }),
        }
      );

      if (result.data) {
        await fetchNetworks();
      }

      return result;
    },
    [makeRequest, fetchNetworks]
  );

  // Test connection for a card network
  const testConnection = useCallback(
    async (network: CardNetworkType): Promise<{ success: boolean; error?: string }> => {
      const result = await makeRequest<{ success: boolean; error?: string }>(
        `/networks/${network}/test`,
        {
          method: 'POST',
        }
      );

      if (result.data) {
        return result.data;
      }

      return { success: false, error: result.error };
    },
    [makeRequest]
  );

  // Disconnect a card network
  const disconnect = useCallback(
    async (network: CardNetworkType): Promise<{ success?: boolean; error?: string }> => {
      const result = await makeRequest<{ message: string }>(
        `/networks/${network}`,
        {
          method: 'DELETE',
        }
      );

      if (result.data) {
        await fetchNetworks();
        return { success: true };
      }

      return { error: result.error };
    },
    [makeRequest, fetchNetworks]
  );

  // Fetch networks on mount
  useEffect(() => {
    fetchNetworks();
  }, [fetchNetworks]);

  // Get status for a specific network
  const getNetworkStatus = useCallback(
    (network: CardNetworkType): CardNetworkConfig | undefined => {
      return networks.find((n) => n.network === network);
    },
    [networks]
  );

  return {
    networks,
    isLoading: isLoading || authLoading,
    error,
    configure,
    testConnection,
    disconnect,
    refresh: fetchNetworks,
    getNetworkStatus,
    networkInfo: CARD_NETWORK_INFO,
  };
}
