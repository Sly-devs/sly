"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, DollarSign } from "lucide-react";
import { useApiConfig } from "@/lib/api-client";
import { formatCurrency } from "@/lib/utils";

import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Button,
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

/** Safe date formatter — returns "—" for missing/invalid dates */
function safeDate(value: string | null | undefined): string {
    if (!value) return "—";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
}

const statusColors: Record<string, string> = {
    open: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    closing: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    closed: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
    exhausted: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    error: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export default function MppSessionsPage() {
    const { authToken, apiKey, apiUrl } = useApiConfig();
    const token = authToken || apiKey;
    const [statusFilter, setStatusFilter] = useState<string>("all");
    const [page, setPage] = useState(0);

    const { data, isLoading } = useQuery({
        queryKey: ["mpp-sessions", statusFilter, page],
        queryFn: async () => {
            const params = new URLSearchParams({ limit: "20", offset: String(page * 20) });
            if (statusFilter !== "all") params.set("status", statusFilter);
            const res = await fetch(`${apiUrl}/v1/mpp/sessions?${params}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return res.json();
        },
        enabled: !!token,
    });

    const sessions = data?.data || [];
    const total = data?.pagination?.total || 0;

    return (
        <div className="p-8 max-w-[1600px] mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">MPP Sessions</h1>
                    <p className="text-muted-foreground">
                        Budget-locked payment channels — agents deposit funds and make micropayments (vouchers) against the balance
                    </p>
                </div>
            </div>

            {/* Filters */}
            <div className="flex gap-4 items-center">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-40">
                        <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="closed">Closed</SelectItem>
                        <SelectItem value="exhausted">Exhausted</SelectItem>
                    </SelectContent>
                </Select>
                <span className="text-sm text-muted-foreground">{total} sessions</span>
            </div>

            {/* Sessions Table */}
            <Card>
                <CardContent className="pt-6">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Service</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Vouchers</TableHead>
                                <TableHead className="text-right">Deposit</TableHead>
                                <TableHead className="text-right">Spent</TableHead>
                                <TableHead>Opened</TableHead>
                                <TableHead></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {sessions.map((s: any) => (
                                <TableRow key={s.id}>
                                    <TableCell className="font-mono text-sm">
                                        {(() => {
                                            try { return new URL(s.serviceUrl).hostname; } catch { return s.serviceUrl || "—"; }
                                        })()}
                                    </TableCell>
                                    <TableCell>
                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColors[s.status] || statusColors.closed}`}>
                                            {s.status}
                                        </span>
                                    </TableCell>
                                    <TableCell>{s.voucherCount ?? 0}</TableCell>
                                    <TableCell className="text-right font-mono">
                                        {formatCurrency(Number(s.depositAmount ?? 0))}
                                    </TableCell>
                                    <TableCell className="text-right font-mono">
                                        {formatCurrency(Number(s.spentAmount ?? 0))}
                                    </TableCell>
                                    <TableCell className="text-sm">
                                        {safeDate(s.openedAt)}
                                    </TableCell>
                                    <TableCell>
                                        <Link href={`/dashboard/agentic-payments/mpp/sessions/${s.id}`}>
                                            <Button variant="ghost" size="sm">View</Button>
                                        </Link>
                                    </TableCell>
                                </TableRow>
                            ))}
                            {sessions.length === 0 && !isLoading && (
                                <TableRow>
                                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                                        No sessions found
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {/* Pagination */}
            {total > 20 && (
                <div className="flex justify-between items-center">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={page === 0}
                    >
                        Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                        Page {page + 1} of {Math.ceil(total / 20)}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => p + 1)}
                        disabled={(page + 1) * 20 >= total}
                    >
                        Next
                    </Button>
                </div>
            )}
        </div>
    );
}
