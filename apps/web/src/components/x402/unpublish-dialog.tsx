"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@sly/ui";
import type { X402Endpoint } from "@sly/api-client";
import { useApiClient } from "@/lib/api-client";

interface UnpublishDialogProps {
    endpoint: X402Endpoint;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess?: () => void;
}

/**
 * Confirmation dialog for unpublishing an x402 endpoint from agentic.market.
 *
 * Surfaces an explicit disclaimer because Coinbase has no documented
 * unpublish API: Sly stops accepting payments immediately (404 from the
 * gateway), but the catalog listing on agentic.market may persist until
 * Coinbase's indexer prunes it on its own schedule.
 */
export function UnpublishDialog({
    endpoint,
    open,
    onOpenChange,
    onSuccess,
}: UnpublishDialogProps) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const [confirmText, setConfirmText] = useState("");

    const unpublishMutation = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error("API client not ready");
            return api.x402Endpoints.unpublish(endpoint.id);
        },
        onSuccess: () => {
            toast.success("Endpoint unpublished", {
                description:
                    "Sly has stopped accepting payments. The catalog listing may persist on agentic.market until Coinbase's indexer prunes it.",
            });
            queryClient.invalidateQueries({ queryKey: ["x402", "endpoint", endpoint.id] });
            queryClient.invalidateQueries({
                queryKey: ["x402", "endpoint", endpoint.id, "publish-status"],
            });
            setConfirmText("");
            onOpenChange(false);
            onSuccess?.();
        },
        onError: (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            toast.error("Unpublish failed", { description: message });
        },
    });

    const handleClose = useCallback(
        (next: boolean) => {
            if (unpublishMutation.isPending) return;
            if (!next) setConfirmText("");
            onOpenChange(next);
        },
        [onOpenChange, unpublishMutation.isPending],
    );

    const isConfirmed = confirmText.trim().toLowerCase() === "unpublish";

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Unpublish from Agentic.Market?</DialogTitle>
                    <DialogDescription>
                        This stops new buyers from paying for{" "}
                        <code className="font-mono text-xs">{endpoint.path}</code>.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 text-sm">
                    <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                        <div className="flex items-start gap-2">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                            <div className="space-y-2">
                                <p className="font-medium text-amber-900 dark:text-amber-200">
                                    Coinbase doesn&apos;t expose an unpublish API.
                                </p>
                                <p className="text-amber-800 dark:text-amber-300">
                                    Your listing on agentic.market may persist until
                                    Coinbase&apos;s indexer prunes it on its own
                                    schedule. Buyers who try to pay through that stale
                                    listing will get a <strong>404</strong> from the
                                    Sly gateway.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <p className="text-gray-600 dark:text-gray-400">
                            What changes immediately:
                        </p>
                        <ul className="ml-5 list-disc space-y-1 text-gray-600 dark:text-gray-400">
                            <li>
                                The Sly gateway returns <strong>404</strong> for this
                                endpoint (no more 402 payment challenge).
                            </li>
                            <li>
                                Future settles route through Sly&apos;s internal
                                facilitator, not CDP.
                            </li>
                            <li>
                                You can re-publish later — the catalog will be
                                updated on the next successful settle.
                            </li>
                        </ul>
                    </div>

                    <div className="space-y-1.5">
                        <label
                            htmlFor="confirm-unpublish"
                            className="text-sm font-medium"
                        >
                            Type <code className="font-mono">unpublish</code> to confirm
                        </label>
                        <input
                            id="confirm-unpublish"
                            type="text"
                            value={confirmText}
                            onChange={(e) => setConfirmText(e.target.value)}
                            disabled={unpublishMutation.isPending}
                            autoComplete="off"
                            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            placeholder="unpublish"
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleClose(false)}
                        disabled={unpublishMutation.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        onClick={() => unpublishMutation.mutate()}
                        disabled={!isConfirmed || unpublishMutation.isPending}
                    >
                        {unpublishMutation.isPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Unpublish
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
