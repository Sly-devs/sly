import { Badge } from "@sly/ui";
import type { X402PublishStatus } from "@sly/api-client";
import { cn } from "@/lib/utils";

interface PublishStatusBadgeProps {
    status: X402PublishStatus;
    className?: string;
}

const statusConfig: Record<
    X402PublishStatus,
    { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className?: string }
> = {
    draft: {
        label: "Draft",
        variant: "outline",
        className: "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300 border-transparent",
    },
    validating: {
        label: "Validating",
        variant: "outline",
        className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-100 border-transparent",
    },
    publishing: {
        label: "Publishing",
        variant: "outline",
        className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-100 border-transparent",
    },
    processing: {
        label: "Indexing",
        variant: "outline",
        className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-100 border-transparent",
    },
    published: {
        label: "Published",
        variant: "outline",
        className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-100 border-transparent",
    },
    failed: {
        label: "Failed",
        variant: "destructive",
    },
    unpublished: {
        label: "Unpublished",
        variant: "secondary",
    },
};

export function PublishStatusBadge({ status, className }: PublishStatusBadgeProps) {
    const config = statusConfig[status] ?? { label: status, variant: "secondary" as const };

    return (
        <Badge variant={config.variant} className={cn("capitalize", config.className, className)}>
            {config.label}
        </Badge>
    );
}
