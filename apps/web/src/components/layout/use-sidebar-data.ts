'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiConfig, useApiFetch } from '@/lib/api-client';

export function useSidebarData() {
  const { authToken, isConfigured, apiEnvironment, apiUrl } = useApiConfig();
  const apiFetch = useApiFetch();

  const { data: protocolData } = useQuery({
    queryKey: ['protocol-status', apiEnvironment],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/organization/protocol-status`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!authToken && isConfigured,
    staleTime: 60_000,
  });

  const { data: meData } = useQuery({
    queryKey: ['auth-me', apiEnvironment],
    queryFn: async () => {
      const res = await apiFetch(`${apiUrl}/v1/auth/me`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!authToken && isConfigured,
    staleTime: 5 * 60_000,
  });

  const me = meData?.data || meData;
  const role = me?.role ?? 'viewer';
  const isAdmin = role === 'owner' || role === 'admin';

  const protocols = protocolData?.protocols;
  const enabledProtocols = {
    ucp: protocols?.ucp?.enabled ?? true,
    acp: protocols?.acp?.enabled ?? true,
    ap2: protocols?.ap2?.enabled ?? true,
    x402: protocols?.x402?.enabled ?? true,
  };

  return { role, isAdmin, enabledProtocols };
}
