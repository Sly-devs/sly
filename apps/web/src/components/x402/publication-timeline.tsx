import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@sly/ui";
import type { X402PublishEvent, X402PublishEventType } from "@sly/api-client";
import {
    AlertCircle,
    CheckCircle2,
    CircleDot,
    Globe,
    Loader2,
    RefreshCcw,
    Send,
    XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PublicationTimelineProps {
    events: X402PublishEvent[];
    className?: string;
}

const eventConfig: Record<
    X402PublishEventType,
    { label: string; description: string; icon: typeof CheckCircle2; tone: "info" | "success" | "warn" | "error" | "muted" }
> = {
    publish_requested: {
        label: "Publish requested",
        description: "Endpoint submitted for validation.",
        icon: Send,
        tone: "info",
    },
    validated: {
        label: "Validated",
        description: "Readiness checks passed.",
        icon: CheckCircle2,
        tone: "success",
    },
    extension_rejected: {
        label: "Extension rejected",
        description: "Coinbase declined the discovery extension.",
        icon: XCircle,
        tone: "error",
    },
    first_settle: {
        label: "First settlement",
        description: "Initial probe payment cleared via CDP facilitator.",
        icon: CheckCircle2,
        tone: "success",
    },
    indexed: {
        label: "Indexed",
        description: "Endpoint visible in agentic.market catalog.",
        icon: Globe,
        tone: "success",
    },
    republish_requested: {
        label: "Republish requested",
        description: "Discovery metadata changed — re-indexing.",
        icon: RefreshCcw,
        tone: "info",
    },
    unpublish_requested: {
        label: "Unpublish requested",
        description: "Visibility flipped to private.",
        icon: CircleDot,
        tone: "muted",
    },
    unpublished: {
        label: "Unpublished",
        description: "Endpoint no longer routes through CDP facilitator.",
        icon: CircleDot,
        tone: "muted",
    },
    failed: {
        label: "Failed",
        description: "Lifecycle terminated with an error.",
        icon: AlertCircle,
        tone: "error",
    },
};

const toneClasses: Record<"info" | "success" | "warn" | "error" | "muted", string> = {
    info: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
    success: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200",
    warn: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-200",
    error: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200",
    muted: "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300",
};

function formatTimestamp(iso: string): string {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

function describeDetails(details: Record<string, unknown> | undefined): string | null {
    if (!details) return null;
    const reason = (details as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
    const message = (details as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    return null;
}

export function PublicationTimeline({ events, className }: PublicationTimelineProps) {
    // Most recent first — we reverse to render chronological top-to-bottom.
    const ordered = [...events].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    return (
        <Card className={className}>
            <CardHeader>
                <CardTitle>Publication timeline</CardTitle>
                <CardDescription>
                    Lifecycle events from publish request to catalog index.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {ordered.length === 0 ? (
                    <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        No publish activity yet — click "Publish to Agentic.Market" to start.
                    </div>
                ) : (
                    <ol className="relative space-y-6 border-l border-gray-200 pl-6 dark:border-gray-800">
                        {ordered.map((event) => {
                            const config = eventConfig[event.event] ?? {
                                label: event.event,
                                description: "",
                                icon: CircleDot,
                                tone: "muted" as const,
                            };
                            const Icon = config.icon;
                            const detail = describeDetails(event.details);

                            return (
                                <li key={event.id} className="relative">
                                    <span
                                        className={cn(
                                            "absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-white dark:ring-gray-950",
                                            toneClasses[config.tone],
                                        )}
                                    >
                                        <Icon className="h-3.5 w-3.5" />
                                    </span>
                                    <div className="flex flex-col">
                                        <div className="flex items-center justify-between gap-3">
                                            <p className="text-sm font-medium">{config.label}</p>
                                            <time className="text-xs text-gray-500 dark:text-gray-400">
                                                {formatTimestamp(event.createdAt)}
                                            </time>
                                        </div>
                                        {config.description && (
                                            <p className="text-sm text-gray-600 dark:text-gray-400">
                                                {config.description}
                                            </p>
                                        )}
                                        {detail && (
                                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">
                                                {detail}
                                            </p>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                )}
            </CardContent>
        </Card>
    );
}
