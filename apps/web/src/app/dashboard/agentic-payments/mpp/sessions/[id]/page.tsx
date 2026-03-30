"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
    ArrowLeft,
    ArrowRight,
    Clock,
    DollarSign,
    ExternalLink,
    Globe,
    Hash,
    User,
    Wallet,
    XCircle,
    Zap,
} from "lucide-react";
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

/** Safe date formatter — returns fallback string for missing/invalid dates */
function safeFormatDate(value: string | null | undefined): string {
    if (!value) return "\u2014";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "\u2014";
    return d.toLocaleString();
}

/** Format duration in human-readable form */
function formatDuration(openedAt: string | null, closedAt: string | null): string {
    if (!openedAt) return "\u2014";
    const start = new Date(openedAt).getTime();
    const end = closedAt ? new Date(closedAt).getTime() : Date.now();
    if (isNaN(start) || isNaN(end)) return "\u2014";
    const diffMs = end - start;
    if (diffMs < 1000) return `${diffMs}ms`;
    const secs = Math.floor(diffMs / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins < 60) return `${mins}m ${remSecs}s`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}h ${remMins}m`;
}

const statusStyles: Record<string, string> = {
    open: "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400",
    active: "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400",
    closed: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
    completed: "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400",
};

export default function MppSessionDetailPage() {
    const params = useParams();
    const sessionId = params.id as string;
    const { authToken, apiKey, apiUrl } = useApiConfig();
    const token = authToken || apiKey;
    const queryClient = useQueryClient();

    const { data: rawData, isLoading, error } = useQuery({
        queryKey: ["mpp-session", sessionId],
        queryFn: async () => {
            const res = await fetch(`${apiUrl}/v1/mpp/sessions/${sessionId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return null;
            const json = await res.json();
            // Unwrap { success, data } envelope
            return json?.data || json;
        },
        enabled: !!token && !!sessionId,
    });

    const closeMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`${apiUrl}/v1/mpp/sessions/${sessionId}/close`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["mpp-session", sessionId] });
        },
    });

    if (isLoading) {
        return (
            <div className="p-8 max-w-[1600px] mx-auto">
                <div className="animate-pulse space-y-6">
                    <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded" />
                    <div className="grid grid-cols-4 gap-4">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="h-28 bg-gray-200 dark:bg-gray-800 rounded-xl" />
                        ))}
                    </div>
                    <div className="h-48 bg-gray-200 dark:bg-gray-800 rounded-xl" />
                </div>
            </div>
        );
    }

    if (error || !rawData || rawData.error) {
        return (
            <div className="p-8 max-w-[1600px] mx-auto">
                <Link
                    href="/dashboard/agentic-payments/mpp"
                    className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-6"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to MPP
                </Link>
                <div className="text-center py-12">
                    <XCircle className="h-16 w-16 text-red-400 mx-auto mb-4" />
                    <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Session not found</h2>
                    <p className="text-gray-500 dark:text-gray-400">
                        The session with ID {sessionId} could not be found.
                    </p>
                </div>
            </div>
        );
    }

    const session = rawData;
    const vouchers: any[] = session.vouchers || [];

    const budget = Number(session.maxBudget ?? session.depositAmount ?? 0) || 0;
    const spent = Number(session.spentAmount ?? 0) || 0;
    const remaining = budget - spent;
    const usagePercent = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    const isActive = session.status === "open" || session.status === "active";

    // Derive agent info from the first voucher's initiatedBy (if available)
    const firstVoucher = vouchers[0];
    const agentName = firstVoucher?.initiatedBy?.name || firstVoucher?.from?.accountName || null;
    const agentId = session.agentId;
    const currency = firstVoucher?.currency || "pathUSD";

    // Service info
    let serviceHostname = "";
    try {
        serviceHostname = new URL(session.serviceUrl).hostname;
    } catch {
        serviceHostname = session.serviceUrl || "Unknown";
    }
    const serviceName = firstVoucher?.to?.accountName || serviceHostname;

    const statusClass = statusStyles[session.status] || statusStyles.closed;

    return (
        <div className="p-8 max-w-[1600px] mx-auto space-y-6">
            <Link
                href="/dashboard/agentic-payments/mpp"
                className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
            >
                <ArrowLeft className="h-4 w-4" />
                Back to MPP
            </Link>

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                            MPP Session
                        </h1>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${statusClass}`}>
                            {session.status}
                        </span>
                    </div>
                    <p className="text-muted-foreground font-mono text-sm">{sessionId}</p>
                </div>
                {isActive && (
                    <Button
                        variant="destructive"
                        onClick={() => closeMutation.mutate()}
                        disabled={closeMutation.isPending}
                    >
                        <XCircle className="h-4 w-4 mr-2" />
                        {closeMutation.isPending ? "Closing..." : "Close Session"}
                    </Button>
                )}
            </div>

            {/* Payment Flow */}
            <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Payment Flow</h3>
                <div className="flex items-center justify-between">
                    {/* From (Agent) */}
                    <div className="flex-1">
                        <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-xl bg-orange-100 dark:bg-orange-950 flex items-center justify-center">
                                <User className="h-6 w-6 text-orange-600" />
                            </div>
                            <div>
                                <p className="text-sm text-gray-500 dark:text-gray-400">From (Agent)</p>
                                <p className="font-medium text-gray-900 dark:text-white">
                                    {agentName || "Agent"}
                                </p>
                                {agentId && (
                                    <Link
                                        href={`/dashboard/agents/${agentId}`}
                                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-mono flex items-center gap-1"
                                    >
                                        {agentId.slice(0, 8)}...
                                        <ExternalLink className="h-3 w-3" />
                                    </Link>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Arrow + Amount */}
                    <div className="flex-shrink-0 px-8">
                        <div className="flex items-center gap-2">
                            <div className="h-px w-12 bg-gray-300 dark:bg-gray-700" />
                            <ArrowRight className="h-6 w-6 text-orange-500" />
                            <div className="h-px w-12 bg-gray-300 dark:bg-gray-700" />
                        </div>
                        <p className="text-center text-lg font-bold text-gray-900 dark:text-white mt-1">
                            {formatCurrency(spent)} / {formatCurrency(budget)}
                        </p>
                        <p className="text-center text-xs text-gray-500 dark:text-gray-400">{currency}</p>
                    </div>

                    {/* To (Service) */}
                    <div className="flex-1 text-right">
                        <div className="flex items-center gap-3 justify-end">
                            <div>
                                <p className="text-sm text-gray-500 dark:text-gray-400">To (Service)</p>
                                <p className="font-medium text-gray-900 dark:text-white">{serviceName}</p>
                                {session.serviceUrl && (
                                    <p className="text-xs text-gray-500 font-mono truncate max-w-[200px] ml-auto">
                                        {session.serviceUrl}
                                    </p>
                                )}
                            </div>
                            <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center">
                                <Globe className="h-6 w-6 text-emerald-600" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Deposit</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{formatCurrency(budget)}</div>
                        <p className="text-xs text-muted-foreground">{currency}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Spent</CardTitle>
                        <Zap className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{formatCurrency(spent)}</div>
                        <div className="mt-2 h-2 rounded-full bg-gray-200 dark:bg-gray-800">
                            <div
                                className={`h-full rounded-full ${usagePercent > 80 ? 'bg-red-500' : usagePercent > 50 ? 'bg-yellow-500' : 'bg-green-500'}`}
                                style={{ width: `${usagePercent}%` }}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{formatCurrency(remaining)} remaining</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Vouchers</CardTitle>
                        <Hash className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{session.voucherCount ?? vouchers.length}</div>
                        <p className="text-xs text-muted-foreground">payments issued</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Duration</CardTitle>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{formatDuration(session.openedAt, session.closedAt)}</div>
                        <p className="text-xs text-muted-foreground">{isActive ? "ongoing" : "total"}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">Method</CardTitle>
                        <Wallet className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold capitalize">
                            {firstVoucher?.protocolMetadata?.payment_method || "tempo"}
                        </div>
                        <p className="text-xs text-muted-foreground">payment rail</p>
                    </CardContent>
                </Card>
            </div>

            {/* Session Info */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Globe className="h-5 w-5" />
                            Session Details
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <dl className="space-y-3">
                            <div className="flex justify-between">
                                <dt className="text-gray-500 dark:text-gray-400">Service URL</dt>
                                <dd className="font-mono text-sm text-right truncate max-w-[280px]">{session.serviceUrl}</dd>
                            </div>
                            <div className="flex justify-between">
                                <dt className="text-gray-500 dark:text-gray-400">Agent</dt>
                                <dd>
                                    <Link
                                        href={`/dashboard/agents/${agentId}`}
                                        className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 justify-end"
                                    >
                                        {agentName && <span className="mr-1">{agentName}</span>}
                                        <span className="font-mono">{agentId?.slice(0, 12)}...</span>
                                        <ExternalLink className="h-3 w-3" />
                                    </Link>
                                </dd>
                            </div>
                            <div className="flex justify-between">
                                <dt className="text-gray-500 dark:text-gray-400">Wallet</dt>
                                <dd className="font-mono text-sm">
                                    {session.walletId?.slice(0, 12)}...
                                </dd>
                            </div>
                            <div className="flex justify-between">
                                <dt className="text-gray-500 dark:text-gray-400">Currency</dt>
                                <dd className="text-sm font-medium">{currency}</dd>
                            </div>
                        </dl>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Clock className="h-5 w-5" />
                            Timeline
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <dl className="space-y-3">
                            <div className="flex justify-between">
                                <dt className="text-gray-500 dark:text-gray-400">Opened</dt>
                                <dd className="text-sm">{safeFormatDate(session.openedAt)}</dd>
                            </div>
                            {session.lastVoucherAt && (
                                <div className="flex justify-between">
                                    <dt className="text-gray-500 dark:text-gray-400">Last Voucher</dt>
                                    <dd className="text-sm">{safeFormatDate(session.lastVoucherAt)}</dd>
                                </div>
                            )}
                            {session.closedAt && (
                                <div className="flex justify-between">
                                    <dt className="text-gray-500 dark:text-gray-400">Closed</dt>
                                    <dd className="text-sm">{safeFormatDate(session.closedAt)}</dd>
                                </div>
                            )}
                            <div className="flex justify-between">
                                <dt className="text-gray-500 dark:text-gray-400">Duration</dt>
                                <dd className="text-sm font-medium">{formatDuration(session.openedAt, session.closedAt)}</dd>
                            </div>
                        </dl>
                    </CardContent>
                </Card>
            </div>

            {/* Voucher History */}
            <Card>
                <CardHeader>
                    <CardTitle>Voucher History</CardTitle>
                    <CardDescription>Individual micropayments issued against this session&apos;s deposit</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-12">#</TableHead>
                                <TableHead>From</TableHead>
                                <TableHead>To</TableHead>
                                <TableHead className="text-right">Amount</TableHead>
                                <TableHead className="text-right">Cumulative</TableHead>
                                <TableHead>Method</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Time</TableHead>
                                <TableHead className="w-12"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {vouchers.map((v: any, i: number) => {
                                const meta = v.protocolMetadata || v.protocol_metadata || {};
                                const vIndex = meta.voucher_index ?? i + 1;
                                const amount = typeof v.amount === "number" ? v.amount : parseFloat(v.amount);
                                // Calculate cumulative from vouchers up to this point
                                const cumulative = vouchers
                                    .slice(0, i + 1)
                                    .reduce((sum: number, vv: any) => sum + (typeof vv.amount === "number" ? vv.amount : parseFloat(vv.amount)), 0);

                                return (
                                    <TableRow key={v.id || i}>
                                        <TableCell className="font-mono text-muted-foreground">
                                            {vIndex}
                                        </TableCell>
                                        <TableCell className="text-sm">
                                            {v.from?.accountName || v.initiatedBy?.name || "Agent"}
                                        </TableCell>
                                        <TableCell className="text-sm">
                                            {v.to?.accountName || serviceName}
                                        </TableCell>
                                        <TableCell className="text-right font-mono font-medium">
                                            {formatCurrency(amount)} <span className="text-muted-foreground text-xs">{v.currency || currency}</span>
                                        </TableCell>
                                        <TableCell className="text-right font-mono text-muted-foreground">
                                            {formatCurrency(cumulative)}
                                        </TableCell>
                                        <TableCell>
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 capitalize">
                                                {meta.payment_method || "tempo"}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400">
                                                {v.status}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {safeFormatDate(v.createdAt ?? v.created_at)}
                                        </TableCell>
                                        <TableCell>
                                            {v.id && (
                                                <Link
                                                    href={`/dashboard/agentic-payments/mpp/payments/${v.id}`}
                                                    className="text-blue-600 dark:text-blue-400 hover:underline"
                                                    title="View transfer"
                                                >
                                                    <ExternalLink className="h-3.5 w-3.5" />
                                                </Link>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                            {vouchers.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                                        No vouchers yet
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
