"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
    AlertTriangle,
    CheckCircle2,
    ExternalLink,
    Loader2,
    XCircle,
} from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
} from "@sly/ui";
import type {
    X402DiscoveryMetadata,
    X402Endpoint,
    X402PublishStatus,
    X402PublishStatusResponse,
    X402ValidateResponse,
    X402ValidationError,
} from "@sly/api-client";
import { useApiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type Step = "review" | "metadata" | "publishing";
type DialogMode = "publish" | "edit";

interface PublishToMarketDialogProps {
    endpoint: X402Endpoint;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** "publish" for first-time publishing, "edit" for republish/manage. */
    mode?: DialogMode;
    onSuccess?: () => void;
}

const TERMINAL_STATUSES: X402PublishStatus[] = ["published", "failed", "unpublished"];
const POLL_INTERVAL_MS = 5000;

interface ChecklistItem {
    label: string;
    ok: boolean;
    detail?: string;
    action?: { label: string; onClick: () => void; loading?: boolean };
}

function formatJsonForEdit(value: unknown): string {
    if (value === undefined || value === null) return "";
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return "";
    }
}

function tryParseJson(input: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const trimmed = input.trim();
    if (!trimmed) return { ok: true, value: undefined };
    try {
        return { ok: true, value: JSON.parse(trimmed) };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
    }
}

export function PublishToMarketDialog({
    endpoint,
    open,
    onOpenChange,
    mode = "publish",
    onSuccess,
}: PublishToMarketDialogProps) {
    const api = useApiClient();
    const queryClient = useQueryClient();

    const [step, setStep] = useState<Step>("review");
    const [validation, setValidation] = useState<X402ValidateResponse | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const [isProvisioningWallet, setIsProvisioningWallet] = useState(false);

    // Metadata form state — seeded from probedMetadata or existing endpoint metadata.
    const [description, setDescription] = useState<string>("");
    const [category, setCategory] = useState<string>("");
    const [inputSchemaText, setInputSchemaText] = useState<string>("");
    const [inputExampleText, setInputExampleText] = useState<string>("");
    const [outputSchemaText, setOutputSchemaText] = useState<string>("");
    const [outputExampleText, setOutputExampleText] = useState<string>("");
    const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});

    // Publishing state
    const [latestStatus, setLatestStatus] = useState<X402PublishStatusResponse | null>(null);
    const [publishError, setPublishError] = useState<string | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const resetMetadataForm = useCallback(
        (probed?: X402DiscoveryMetadata | null) => {
            const base: X402DiscoveryMetadata | null =
                probed ?? endpoint.discoveryMetadata ?? null;
            setDescription(base?.description ?? endpoint.description ?? "");
            setCategory(base?.category ?? endpoint.category ?? "");
            setInputSchemaText(formatJsonForEdit(base?.input?.schema));
            setInputExampleText(formatJsonForEdit(base?.input?.example));
            setOutputSchemaText(formatJsonForEdit(base?.output?.schema));
            setOutputExampleText(formatJsonForEdit(base?.output?.example));
            setJsonErrors({});
        },
        [endpoint.discoveryMetadata, endpoint.description, endpoint.category],
    );

    const runValidate = useCallback(async () => {
        if (!api) return;
        setIsValidating(true);
        try {
            const result = await api.x402Endpoints.validate(endpoint.id);
            setValidation(result);
            resetMetadataForm(result.probedMetadata ?? null);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Validation failed";
            toast.error("Validation failed", { description: message });
            setValidation({
                ok: false,
                errors: [{ field: "endpoint", reason: message }],
                walletReady: false,
                reachable: false,
            });
        } finally {
            setIsValidating(false);
        }
    }, [api, endpoint.id, resetMetadataForm]);

    // Run validation when dialog opens.
    useEffect(() => {
        if (!open) return;
        setStep("review");
        setPublishError(null);
        setLatestStatus(null);
        runValidate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, endpoint.id]);

    // Stop polling on close/unmount.
    useEffect(() => {
        return () => {
            if (pollTimerRef.current) {
                clearTimeout(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        };
    }, []);

    const errorByField = useMemo(() => {
        const map = new Map<string, string>();
        validation?.errors?.forEach((e) => {
            if (!map.has(e.field)) map.set(e.field, e.reason);
        });
        return map;
    }, [validation]);

    const checklist: ChecklistItem[] = useMemo(() => {
        const meta = validation?.probedMetadata ?? endpoint.discoveryMetadata ?? null;
        return [
            {
                label: "Endpoint reachable",
                ok: !!validation?.reachable,
                detail: validation?.reachable
                    ? undefined
                    : (errorByField.get("endpoint") ?? "We couldn't reach the configured backend."),
            },
            {
                label: "Description ≥ 20 characters",
                ok: (description?.trim().length ?? 0) >= 20,
                detail:
                    (description?.trim().length ?? 0) >= 20
                        ? undefined
                        : "Add a longer description in the next step.",
            },
            {
                label: `Wallet bound for ${endpoint.network}`,
                ok: !!validation?.walletReady,
                detail: validation?.walletReady
                    ? undefined
                    : (errorByField.get("payTo") ??
                        "Bind a payout wallet so buyers can settle on-chain."),
                action: validation?.walletReady
                    ? undefined
                    : {
                        label: "Auto-provision wallet",
                        loading: isProvisioningWallet,
                        onClick: async () => {
                            if (!api) return;
                            setIsProvisioningWallet(true);
                            try {
                                // Auto-provision: omitting `address` asks the API to
                                // mint a Sly-managed CDP smart wallet. Worktree B's
                                // route accepts this pattern; the static type is
                                // address-required, so cast through `unknown`.
                                await api.tenantPayoutWallets.bind({
                                    accountId: endpoint.accountId,
                                    network: endpoint.network,
                                    provider: "cdp",
                                } as unknown as Parameters<
                                    typeof api.tenantPayoutWallets.bind
                                >[0]);
                                toast.success("Wallet provisioned");
                                await runValidate();
                            } catch (err) {
                                toast.error("Auto-provision failed", {
                                    description:
                                        err instanceof Error ? err.message : "Could not provision wallet",
                                });
                            } finally {
                                setIsProvisioningWallet(false);
                            }
                        },
                    },
            },
            {
                label: "Schema + example present",
                ok: !!(meta?.input?.schema || meta?.output?.schema || meta?.output?.example),
                detail: meta?.input?.schema || meta?.output?.schema || meta?.output?.example
                    ? undefined
                    : "Auto-probe couldn't infer schema. Provide one in the next step.",
            },
        ];
    }, [
        validation,
        endpoint.discoveryMetadata,
        endpoint.network,
        endpoint.accountId,
        description,
        errorByField,
        api,
        isProvisioningWallet,
        runValidate,
    ]);

    const allChecksPass = checklist.every((c) => c.ok);

    // Validate JSON fields and return parsed metadata override.
    const buildMetadataOverride = useCallback((): {
        ok: boolean;
        metadata?: Partial<X402DiscoveryMetadata>;
    } => {
        const errors: Record<string, string> = {};
        const parsedInputSchema = tryParseJson(inputSchemaText);
        const parsedInputExample = tryParseJson(inputExampleText);
        const parsedOutputSchema = tryParseJson(outputSchemaText);
        const parsedOutputExample = tryParseJson(outputExampleText);

        if (!parsedInputSchema.ok) errors.inputSchema = parsedInputSchema.error;
        if (!parsedInputExample.ok) errors.inputExample = parsedInputExample.error;
        if (!parsedOutputSchema.ok) errors.outputSchema = parsedOutputSchema.error;
        if (!parsedOutputExample.ok) errors.outputExample = parsedOutputExample.error;

        setJsonErrors(errors);
        if (Object.keys(errors).length > 0) {
            return { ok: false };
        }

        const trimmedDescription = description.trim();
        const trimmedCategory = category.trim();

        const metadata: Partial<X402DiscoveryMetadata> = {};
        if (trimmedDescription) metadata.description = trimmedDescription;
        if (trimmedCategory) metadata.category = trimmedCategory;

        const inputSchema = parsedInputSchema.ok ? parsedInputSchema.value : undefined;
        const inputExample = parsedInputExample.ok ? parsedInputExample.value : undefined;
        const outputSchema = parsedOutputSchema.ok ? parsedOutputSchema.value : undefined;
        const outputExample = parsedOutputExample.ok ? parsedOutputExample.value : undefined;

        if (inputSchema !== undefined || inputExample !== undefined) {
            metadata.input = {};
            if (inputSchema !== undefined) {
                metadata.input.schema = inputSchema as Record<string, unknown>;
            }
            if (inputExample !== undefined) metadata.input.example = inputExample;
        }
        if (outputSchema !== undefined || outputExample !== undefined) {
            metadata.output = {};
            if (outputSchema !== undefined) {
                metadata.output.schema = outputSchema as Record<string, unknown>;
            }
            if (outputExample !== undefined) metadata.output.example = outputExample;
        }

        return { ok: true, metadata };
    }, [description, category, inputSchemaText, inputExampleText, outputSchemaText, outputExampleText]);

    const pollPublishStatus = useCallback(async () => {
        if (!api) return;
        try {
            const status = await api.x402Endpoints.getPublishStatus(endpoint.id);
            setLatestStatus(status);
            if (status.publishError) setPublishError(status.publishError);

            if (TERMINAL_STATUSES.includes(status.publishStatus)) {
                if (status.publishStatus === "published") {
                    toast.success("Published to Agentic.Market");
                    queryClient.invalidateQueries({ queryKey: ["x402", "endpoint", endpoint.id] });
                    onSuccess?.();
                } else if (status.publishStatus === "failed") {
                    toast.error("Publish failed", {
                        description: status.publishError ?? undefined,
                    });
                }
                return;
            }

            pollTimerRef.current = setTimeout(pollPublishStatus, POLL_INTERVAL_MS);
        } catch (err) {
            // Soft-fail: keep polling but surface the error.
            const message = err instanceof Error ? err.message : "Status polling failed";
            setPublishError(message);
            pollTimerRef.current = setTimeout(pollPublishStatus, POLL_INTERVAL_MS);
        }
    }, [api, endpoint.id, queryClient, onSuccess]);

    const publishMutation = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error("API client not initialized");
            const built = buildMetadataOverride();
            if (!built.ok) {
                throw new Error("Fix the JSON errors before publishing.");
            }
            return api.x402Endpoints.publish(endpoint.id, {
                metadataOverride: built.metadata,
                force: mode === "edit",
            });
        },
        onSuccess: (result) => {
            setPublishError(result.publishError ?? null);
            setStep("publishing");
            // Seed initial status and start polling.
            setLatestStatus({
                publishStatus: result.publishStatus,
                publishError: result.publishError ?? null,
                events: [],
            } as X402PublishStatusResponse);

            if (TERMINAL_STATUSES.includes(result.publishStatus)) {
                if (result.publishStatus === "published") {
                    toast.success("Published to Agentic.Market");
                    queryClient.invalidateQueries({ queryKey: ["x402", "endpoint", endpoint.id] });
                    onSuccess?.();
                }
                return;
            }
            pollPublishStatus();
        },
        onError: (err: unknown) => {
            const message = err instanceof Error ? err.message : "Publish failed";
            setPublishError(message);
            toast.error("Publish failed", { description: message });
        },
    });

    const handleClose = useCallback(
        (next: boolean) => {
            if (publishMutation.isPending) return; // don't close mid-call
            if (pollTimerRef.current) {
                clearTimeout(pollTimerRef.current);
                pollTimerRef.current = null;
            }
            onOpenChange(next);
        },
        [onOpenChange, publishMutation.isPending],
    );

    const submitButtonLabel = useMemo(() => {
        if (mode === "edit") return "Save & republish";
        return "Publish to Agentic.Market";
    }, [mode]);

    const dialogTitle = mode === "edit" ? "Manage publication" : "Publish to Agentic.Market";
    const dialogDescription =
        mode === "edit"
            ? "Update discovery metadata. Saving triggers an automatic re-index."
            : "List this endpoint in Coinbase's Bazaar so external agents can discover and pay for it.";

    const currentStatus = latestStatus?.publishStatus;

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{dialogTitle}</DialogTitle>
                    <DialogDescription>{dialogDescription}</DialogDescription>
                </DialogHeader>

                {step === "review" && (
                    <div className="space-y-4">
                        <div className="space-y-3">
                            <h3 className="text-sm font-semibold">Readiness checklist</h3>
                            {isValidating && !validation ? (
                                <div className="flex items-center gap-2 text-sm text-gray-500">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Running checks against the gateway…
                                </div>
                            ) : (
                                <ul className="space-y-2">
                                    {checklist.map((item) => (
                                        <li
                                            key={item.label}
                                            className={cn(
                                                "flex items-start gap-3 rounded-md border p-3",
                                                item.ok
                                                    ? "border-green-200 bg-green-50/40 dark:border-green-900 dark:bg-green-950/20"
                                                    : "border-red-200 bg-red-50/40 dark:border-red-900 dark:bg-red-950/20",
                                            )}
                                        >
                                            {item.ok ? (
                                                <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400" />
                                            ) : (
                                                <XCircle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
                                            )}
                                            <div className="flex-1">
                                                <p className="text-sm font-medium">{item.label}</p>
                                                {item.detail && (
                                                    <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                                                        {item.detail}
                                                    </p>
                                                )}
                                                {item.action && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        className="mt-2"
                                                        onClick={item.action.onClick}
                                                        disabled={item.action.loading}
                                                    >
                                                        {item.action.loading && (
                                                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                                        )}
                                                        {item.action.label}
                                                    </Button>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => handleClose(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={runValidate}
                                disabled={isValidating}
                            >
                                {isValidating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Re-run validation
                            </Button>
                            <Button
                                type="button"
                                onClick={() => setStep("metadata")}
                                disabled={!allChecksPass && mode === "publish"}
                            >
                                Continue
                            </Button>
                        </DialogFooter>
                    </div>
                )}

                {step === "metadata" && (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="x402-publish-description">Description</Label>
                            <textarea
                                id="x402-publish-description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="What does this endpoint return? (20–280 chars)"
                                className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                maxLength={280}
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {description.trim().length} / 280
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="x402-publish-category">Category (optional)</Label>
                            <Input
                                id="x402-publish-category"
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                placeholder="e.g. data, ai, weather"
                            />
                        </div>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <JsonField
                                id="x402-publish-input-schema"
                                label="Input schema (JSON)"
                                value={inputSchemaText}
                                onChange={setInputSchemaText}
                                error={jsonErrors.inputSchema}
                                placeholder='{ "type": "object", "properties": {} }'
                            />
                            <JsonField
                                id="x402-publish-input-example"
                                label="Input example"
                                value={inputExampleText}
                                onChange={setInputExampleText}
                                error={jsonErrors.inputExample}
                                placeholder='{ "city": "San Francisco" }'
                            />
                            <JsonField
                                id="x402-publish-output-schema"
                                label="Output schema (JSON)"
                                value={outputSchemaText}
                                onChange={setOutputSchemaText}
                                error={jsonErrors.outputSchema}
                                placeholder='{ "type": "object" }'
                            />
                            <JsonField
                                id="x402-publish-output-example"
                                label="Output example"
                                value={outputExampleText}
                                onChange={setOutputExampleText}
                                error={jsonErrors.outputExample}
                                placeholder='{ "tempF": 64 }'
                            />
                        </div>

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setStep("review")}
                            >
                                Back
                            </Button>
                            <Button
                                type="button"
                                onClick={() => publishMutation.mutate()}
                                disabled={publishMutation.isPending}
                            >
                                {publishMutation.isPending && (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                )}
                                {submitButtonLabel}
                            </Button>
                        </DialogFooter>
                    </div>
                )}

                {step === "publishing" && (
                    <div className="space-y-4">
                        <div className="rounded-md border p-4">
                            <div className="flex items-center gap-3">
                                {currentStatus === "published" ? (
                                    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                                ) : currentStatus === "failed" ? (
                                    <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
                                ) : (
                                    <Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />
                                )}
                                <div>
                                    <p className="text-sm font-medium">
                                        {currentStatus === "published"
                                            ? "Published"
                                            : currentStatus === "failed"
                                              ? "Publish failed"
                                              : `Status: ${currentStatus ?? "publishing"}`}
                                    </p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        Polling agentic.market for catalog confirmation.
                                    </p>
                                </div>
                            </div>
                            {publishError && (
                                <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle className="h-4 w-4 shrink-0" />
                                        <span>{publishError}</span>
                                    </div>
                                </div>
                            )}
                            {latestStatus?.catalogServiceId && (
                                <div className="mt-3 flex items-center gap-2 text-sm">
                                    <ExternalLink className="h-4 w-4" />
                                    <a
                                        href={`https://agentic.market/services/${latestStatus.catalogServiceId}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                                    >
                                        View on Agentic.Market
                                    </a>
                                </div>
                            )}
                        </div>

                        <DialogFooter>
                            {currentStatus === "failed" && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        setStep("review");
                                        runValidate();
                                    }}
                                >
                                    Re-run validation
                                </Button>
                            )}
                            <Button
                                type="button"
                                onClick={() => handleClose(false)}
                                disabled={publishMutation.isPending}
                            >
                                Close
                            </Button>
                        </DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

interface JsonFieldProps {
    id: string;
    label: string;
    value: string;
    onChange: (next: string) => void;
    error?: string;
    placeholder?: string;
}

function JsonField({ id, label, value, onChange, error, placeholder }: JsonFieldProps) {
    return (
        <div className="space-y-1.5">
            <Label htmlFor={id}>{label}</Label>
            <textarea
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                className={cn(
                    "flex min-h-[120px] w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    error
                        ? "border-red-400 focus-visible:ring-red-400"
                        : "border-input",
                )}
            />
            {error && (
                <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            )}
        </div>
    );
}
