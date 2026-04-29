"use client";

/**
 * Admin: x402 Publications
 *
 * Cross-tenant audit table of all x402 endpoints that have entered the
 * publish lifecycle. Surfaces failures so operators can intervene before
 * a tenant notices. Gated to dashboard role 'owner' or 'admin'.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@sly/ui";
import { ShieldAlert, Loader2 } from "lucide-react";
import type {
    X402Endpoint,
    X402EndpointsListParams,
    X402PublishStatus,
} from "@sly/api-client";
import { PublishStatusBadge } from "@/components/x402/publish-status-badge";
import { useApiClient, useApiConfig, useApiFetch } from "@/lib/api-client";
import { TableSkeleton } from "@/components/ui/skeletons";

const PUBLISH_STATUSES: X402PublishStatus[] = [
    "draft",
    "validating",
    "publishing",
    "processing",
    "published",
    "failed",
    "unpublished",
];

interface CurrentUser {
    role?: string;
    tenantId?: string;
}

export default function AdminX402PublicationsPage() {
    const api = useApiClient();
    const { apiUrl } = useApiConfig();
    const apiFetch = useApiFetch();

    const [statusFilter, setStatusFilter] = useState<X402PublishStatus | "all">("all");
    const [tenantFilter, setTenantFilter] = useState<string>("");
    const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
    const [authError, setAuthError] = useState<string | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    // Resolve role from /v1/auth/me — same shape as the team settings page.
    useEffect(() => {
        let cancelled = false;
        async function fetchMe() {
            try {
                const res = await apiFetch(`${apiUrl}/v1/auth/me`);
                if (!res.ok) {
                    if (!cancelled) setAuthError("Failed to verify access");
                    return;
                }
                const json = await res.json();
                const me = json?.data ?? json;
                const role = me?.user?.role ?? me?.role;
                const tenantId = me?.tenant?.id ?? me?.tenantId;
                if (!cancelled) setCurrentUser({ role, tenantId });
            } catch (err) {
                if (!cancelled) {
                    setAuthError(err instanceof Error ? err.message : "Failed to verify access");
                }
            } finally {
                if (!cancelled) setAuthLoading(false);
            }
        }
        fetchMe();
        return () => {
            cancelled = true;
        };
    }, [apiFetch, apiUrl]);

    const isAdmin = currentUser?.role === "admin" || currentUser?.role === "owner";

    const queryParams = useMemo<X402EndpointsListParams>(() => {
        const params: X402EndpointsListParams = { limit: 50 };
        if (statusFilter !== "all") params.publishStatus = statusFilter;
        return params;
    }, [statusFilter]);

    const { data, isLoading, refetch, isFetching } = useQuery({
        queryKey: ["admin", "x402-publications", queryParams, tenantFilter],
        queryFn: async () => {
            if (!api) return { data: [] as X402Endpoint[] };
            const result = await api.x402Endpoints.list(queryParams);
            return result;
        },
        enabled: !!api && isAdmin,
    });

    const endpoints: X402Endpoint[] = useMemo(() => {
        const raw = data as unknown as { data?: X402Endpoint[] } | X402Endpoint[] | undefined;
        const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
        const trimmed = tenantFilter.trim().toLowerCase();
        if (!trimmed) return list;
        return list.filter((e) => e.tenantId.toLowerCase().includes(trimmed));
    }, [data, tenantFilter]);

    if (authLoading) {
        return (
            <div className="p-8 max-w-[1600px] mx-auto">
                <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
            </div>
        );
    }

    if (authError || !isAdmin) {
        return (
            <div className="p-8 max-w-[1600px] mx-auto">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <ShieldAlert className="h-5 w-5 text-red-600" />
                            Restricted
                        </CardTitle>
                        <CardDescription>
                            {authError ??
                                "This page is available to dashboard admins and owners only."}
                        </CardDescription>
                    </CardHeader>
                </Card>
            </div>
        );
    }

    return (
        <div className="p-8 max-w-[1600px] mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">x402 Publications</h1>
                    <p className="text-gray-500 dark:text-gray-400 mt-1">
                        Cross-tenant view of endpoints in the agentic.market publish lifecycle.
                    </p>
                </div>
                <Button
                    variant="outline"
                    onClick={() => refetch()}
                    disabled={isFetching}
                >
                    {isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Refresh
                </Button>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Filters</CardTitle>
                    <CardDescription>
                        Drill into stuck or failed publications.
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium">Publish status</label>
                        <Select
                            value={statusFilter}
                            onValueChange={(v) => setStatusFilter(v as X402PublishStatus | "all")}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="All statuses" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All statuses</SelectItem>
                                {PUBLISH_STATUSES.map((status) => (
                                    <SelectItem key={status} value={status}>
                                        {status}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5 md:col-span-2">
                        <label className="text-sm font-medium">Tenant ID contains</label>
                        <Input
                            value={tenantFilter}
                            onChange={(e) => setTenantFilter(e.target.value)}
                            placeholder="e.g. 8f3c…"
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Endpoints ({endpoints.length})</CardTitle>
                    <CardDescription>
                        Showing up to 50 results — refine filters to narrow.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <TableSkeleton rows={6} columns={6} />
                    ) : endpoints.length === 0 ? (
                        <div className="text-center py-12 text-gray-500">
                            No matching endpoints.
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Endpoint</TableHead>
                                    <TableHead>Tenant</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Visibility</TableHead>
                                    <TableHead>Published</TableHead>
                                    <TableHead>Last error</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {endpoints.map((endpoint) => (
                                    <TableRow key={endpoint.id}>
                                        <TableCell>
                                            <div className="font-medium">{endpoint.name}</div>
                                            <div className="text-xs text-gray-500 font-mono">
                                                {endpoint.method} {endpoint.path}
                                            </div>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">
                                            {endpoint.tenantId.slice(0, 8)}…
                                        </TableCell>
                                        <TableCell>
                                            <PublishStatusBadge
                                                status={endpoint.publishStatus ?? "draft"}
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline">
                                                {endpoint.visibility ?? "private"}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-xs">
                                            {endpoint.publishedAt
                                                ? new Date(endpoint.publishedAt).toLocaleString()
                                                : "—"}
                                        </TableCell>
                                        <TableCell className="max-w-[280px] truncate text-xs text-red-600 dark:text-red-400">
                                            {endpoint.publishError ?? "—"}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
