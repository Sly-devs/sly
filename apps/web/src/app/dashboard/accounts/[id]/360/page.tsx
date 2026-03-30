'use client';

import { use, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiConfig } from '@/lib/api-client';
import { AccountContext } from '@/types/context';
import { AccountHeader } from '@/components/dashboard/account-360/AccountHeader';
import { BalancesCard } from '@/components/dashboard/account-360/BalancesCard';
import { PendingItemsCard } from '@/components/dashboard/account-360/PendingItemsCard';
import { LimitsCard } from '@/components/dashboard/account-360/LimitsCard';
import { RecentActivity } from '@/components/dashboard/account-360/RecentActivity';
import { PaymentMethodsCard } from '@/components/dashboard/account-360/PaymentMethodsCard';
import { ComplianceCard } from '@/components/dashboard/account-360/ComplianceCard';
import { ActionsBar } from '@/components/dashboard/account-360/ActionsBar';
import { Skeleton } from '@/components/ui/skeletons'; // Assuming generic skeletons exist, checks indicated skeletons.tsx exists in ui
import { AlertCircle } from 'lucide-react';
import { useParams } from 'next/navigation';

// Helper to fetch context
async function fetchAccountContext(id: string, token: string | null, apiUrl: string): Promise<AccountContext> {
    const headers: HeadersInit = {
        'Content-Type': 'application/json',
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${apiUrl}/v1/context/account/${id}`, { headers });

    if (!res.ok) {
        throw new Error(`Failed to fetch account context: ${res.statusText}`);
    }

    const json = await res.json();
    return json.data;
}

export default function Account360Page() {
    const params = useParams(); // Use useParams hook instead of props for client component
    const id = params?.id as string;
    const { authToken, isConfigured, apiUrl } = useApiConfig();

    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['account-context', id],
        queryFn: () => fetchAccountContext(id, authToken, apiUrl),
        enabled: !!id && isConfigured,
        staleTime: 30000, // 30 seconds
    });

    if (isLoading) {
        return <Account360Skeleton />;
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center p-12 text-center h-[50vh]">
                <div className="w-16 h-16 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center mb-4">
                    <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
                </div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Error Loading Account Context</h2>
                <p className="text-gray-500 max-w-md mb-6">{error.message}</p>
                <button
                    onClick={() => refetch()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                >
                    Try Again
                </button>
            </div>
        );
    }

    if (!data) {
        return null; // Should be handled by loading or error
    }

    return (
        <div className="space-y-6 container mx-auto px-4 py-8 max-w-7xl animate-in fade-in duration-500">
            <AccountHeader
                account={data.account}
                lastUpdated={new Date().toISOString()} // API doesn't return meta in data usually, or I need to update type to include full response
                onRefresh={() => refetch()}
                isLoading={isLoading}
            />

            <ActionsBar actions={data.suggested_actions} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left Column - Financials */}
                <div className="lg:col-span-2 space-y-6">
                    <BalancesCard balances={data.balances} />
                    <RecentActivity activity={data.activity} accountId={data.account.id} />
                </div>

                {/* Right Column - Status & Actions */}
                <div className="space-y-6">
                    <PendingItemsCard pendingItems={(data as any).pending_items} /* Cast to any for now if type missing */ />
                    <LimitsCard limits={data.limits} />
                    <ComplianceCard compliance={data.compliance} />
                    <PaymentMethodsCard />
                </div>
            </div>
        </div>
    );
}

function Account360Skeleton() {
    return (
        <div className="space-y-6 container mx-auto px-4 py-8 max-w-7xl">
            <div className="flex justify-between items-center">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-64" />
                    <Skeleton className="h-4 w-96" />
                </div>
                <Skeleton className="h-4 w-32" />
            </div>

            <Skeleton className="h-24 w-full rounded-xl" />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">
                    <Skeleton className="h-64 w-full rounded-xl" />
                    <Skeleton className="h-64 w-full rounded-xl" />
                </div>
                <div className="space-y-6">
                    <Skeleton className="h-40 w-full rounded-xl" />
                    <Skeleton className="h-40 w-full rounded-xl" />
                    <Skeleton className="h-40 w-full rounded-xl" />
                </div>
            </div>
        </div>
    )
}
