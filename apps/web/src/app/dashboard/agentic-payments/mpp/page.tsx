"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Zap, Activity, DollarSign, Clock } from "lucide-react";
import { useApiConfig } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";

import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Button,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@sly/ui";

/** Safe date formatter — returns "—" for missing/invalid dates */
function safeDate(value: string | null | undefined): string {
    if (!value) return "—";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
}

/** Extract hostname from a URL string, safely */
function hostname(url: string | undefined): string {
    if (!url) return "—";
    try { return new URL(url).hostname; } catch { return url; }
}

export default function MppOverviewPage() {
    const { authToken, apiKey, apiUrl } = useApiConfig();
    const token = authToken || apiKey;

    const { data: sessions } = useQuery({
        queryKey: ["mpp-sessions"],
        queryFn: async () => {
            const res = await fetch(`${apiUrl}/v1/mpp/sessions?limit=10`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return res.json();
        },
        enabled: !!token,
    });

    const { data: transfers } = useQuery({
        queryKey: ["mpp-transfers"],
        queryFn: async () => {
            const res = await fetch(`${apiUrl}/v1/mpp/transfers?limit=10`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return res.json();
        },
        enabled: !!token,
    });

    const activeSessions = sessions?.data?.filter(
        (s: any) => s.status === "open" || s.status === "active"
    )?.length ?? 0;

    // transfers are now camelCase from mapTransferFromDb
    const totalSpent = transfers?.data?.reduce(
        (sum: number, t: any) => sum + (Number(t.amount) || 0),
        0
    ) ?? 0;

    return (
        <div className="p-8 max-w-[1600px] mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Machine Payments Protocol</h1>
                    <p className="text-muted-foreground">
                        HTTP 402 machine-to-machine payments with governance
                    </p>
                </div>
                <div className="flex gap-2">
                    <Link href="/dashboard/agentic-payments/mpp/sessions">
                        <Button variant="outline">View Sessions</Button>
                    </Link>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Active Sessions</CardTitle>
                        <Activity className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{activeSessions}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Total Payments</CardTitle>
                        <Zap className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {transfers?.pagination?.total ?? transfers?.total ?? 0}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {formatCurrency(totalSpent)}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {sessions?.pagination?.total ?? 0}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Recent Transfers — fields are camelCase from mapTransferFromDb */}
            <Card>
                <CardHeader>
                    <CardTitle>Recent Payments</CardTitle>
                    <CardDescription>Latest MPP payments across all agents</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Date</TableHead>
                                <TableHead>Service</TableHead>
                                <TableHead>Agent</TableHead>
                                <TableHead>Method</TableHead>
                                <TableHead className="text-right">Amount</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {(transfers?.data || []).slice(0, 10).map((t: any) => {
                                const meta = t.protocolMetadata || t.protocol_metadata || {};
                                return (
                                    <TableRow key={t.id}>
                                        <TableCell className="text-sm">
                                            {safeDate(t.createdAt || t.created_at)}
                                        </TableCell>
                                        <TableCell className="font-mono text-sm">
                                            {hostname(meta.service_url)}
                                        </TableCell>
                                        <TableCell className="text-sm">
                                            {t.from?.accountName?.trim() || t.initiatedBy?.name?.trim() || t.description || "—"}
                                        </TableCell>
                                        <TableCell>
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                                                {meta.payment_method || "tempo"}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                            {formatCurrency(Number(t.amount) || 0)}
                                        </TableCell>
                                        <TableCell>
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                                                {t.status}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <Link href={`/dashboard/agentic-payments/mpp/payments/${t.id}`}>
                                                <Button variant="ghost" size="sm">View</Button>
                                            </Link>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                            {(!transfers?.data || transfers.data.length === 0) && (
                                <TableRow>
                                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                                        No MPP payments yet
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
