'use client';

import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/lib/api-client";
import { toast } from "sonner";
import { X, Plus, Info, Pencil, Save } from "lucide-react";
import {
    Button,
    Card,
    Input,
    Label,
    Switch,
} from "@sly/ui";
import { SpendingPolicy, Wallet } from "@sly/api-client";
import { SpendingProgress } from "./spending-progress";
import { cn } from "@/lib/utils";

interface SpendingPolicyEditorProps {
    wallet: Wallet;
    className?: string;
}

interface PolicyFormData {
    dailySpendLimit: string;
    monthlySpendLimit: string;
    requiresApprovalAbove: string;
    approvedVendors: string[];
    approvedEndpoints: string[];
    autoFundEnabled: boolean;
    autoFundThreshold: string;
    autoFundAmount: string;
}

/**
 * Spending Policy Editor component
 * Displays current usage and allows editing of spending policies
 */
export function SpendingPolicyEditor({ wallet, className }: SpendingPolicyEditorProps) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const [isEditing, setIsEditing] = useState(false);
    const [newVendor, setNewVendor] = useState('');
    const [newEndpoint, setNewEndpoint] = useState('');

    const policy = wallet.spendingPolicy || {};

    // Form state
    const [formData, setFormData] = useState<PolicyFormData>({
        dailySpendLimit: policy.dailySpendLimit?.toString() || '',
        monthlySpendLimit: policy.monthlySpendLimit?.toString() || '',
        requiresApprovalAbove: (policy.requiresApprovalAbove ?? policy.approvalThreshold)?.toString() || '',
        approvedVendors: policy.approvedVendors || [],
        approvedEndpoints: policy.approvedEndpoints || [],
        autoFundEnabled: policy.autoFundEnabled || false,
        autoFundThreshold: policy.autoFundThreshold?.toString() || '',
        autoFundAmount: policy.autoFundAmount?.toString() || '',
    });

    // Reset form to current wallet data
    const resetForm = useCallback(() => {
        const p = wallet.spendingPolicy || {};
        setFormData({
            dailySpendLimit: p.dailySpendLimit?.toString() || '',
            monthlySpendLimit: p.monthlySpendLimit?.toString() || '',
            requiresApprovalAbove: (p.requiresApprovalAbove ?? p.approvalThreshold)?.toString() || '',
            approvedVendors: p.approvedVendors || [],
            approvedEndpoints: p.approvedEndpoints || [],
            autoFundEnabled: p.autoFundEnabled || false,
            autoFundThreshold: p.autoFundThreshold?.toString() || '',
            autoFundAmount: p.autoFundAmount?.toString() || '',
        });
    }, [wallet.spendingPolicy]);

    // Update mutation
    const updateMutation = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error("API client not initialized");

            const spendingPolicy: Partial<SpendingPolicy> = {};

            // Parse numeric values
            if (formData.dailySpendLimit) {
                spendingPolicy.dailySpendLimit = parseFloat(formData.dailySpendLimit);
            }
            if (formData.monthlySpendLimit) {
                spendingPolicy.monthlySpendLimit = parseFloat(formData.monthlySpendLimit);
            }
            if (formData.requiresApprovalAbove) {
                spendingPolicy.requiresApprovalAbove = parseFloat(formData.requiresApprovalAbove);
            }

            // Allowlists
            if (formData.approvedVendors.length > 0) {
                spendingPolicy.approvedVendors = formData.approvedVendors;
            }
            if (formData.approvedEndpoints.length > 0) {
                spendingPolicy.approvedEndpoints = formData.approvedEndpoints;
            }

            // Auto-fund settings
            spendingPolicy.autoFundEnabled = formData.autoFundEnabled;
            if (formData.autoFundEnabled) {
                if (formData.autoFundThreshold) {
                    spendingPolicy.autoFundThreshold = parseFloat(formData.autoFundThreshold);
                }
                if (formData.autoFundAmount) {
                    spendingPolicy.autoFundAmount = parseFloat(formData.autoFundAmount);
                }
            }

            return api.wallets.update(wallet.id, { spendingPolicy });
        },
        onSuccess: () => {
            toast.success("Spending policy updated successfully");
            queryClient.invalidateQueries({ queryKey: ["wallet", wallet.id] });
            setIsEditing(false);
        },
        onError: (error: any) => {
            toast.error(error.message || "Failed to update spending policy");
        }
    });

    // Add vendor tag
    const addVendor = () => {
        const trimmed = newVendor.trim();
        if (trimmed && !formData.approvedVendors.includes(trimmed)) {
            setFormData(prev => ({
                ...prev,
                approvedVendors: [...prev.approvedVendors, trimmed]
            }));
            setNewVendor('');
        }
    };

    // Remove vendor tag
    const removeVendor = (vendor: string) => {
        setFormData(prev => ({
            ...prev,
            approvedVendors: prev.approvedVendors.filter(v => v !== vendor)
        }));
    };

    // Add endpoint tag
    const addEndpoint = () => {
        const trimmed = newEndpoint.trim();
        if (trimmed && !formData.approvedEndpoints.includes(trimmed)) {
            setFormData(prev => ({
                ...prev,
                approvedEndpoints: [...prev.approvedEndpoints, trimmed]
            }));
            setNewEndpoint('');
        }
    };

    // Remove endpoint tag
    const removeEndpoint = (endpoint: string) => {
        setFormData(prev => ({
            ...prev,
            approvedEndpoints: prev.approvedEndpoints.filter(e => e !== endpoint)
        }));
    };

    const handleCancel = () => {
        resetForm();
        setIsEditing(false);
    };

    return (
        <Card className={cn("p-6", className)}>
            <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Spending Policy
                </h3>
                {!isEditing ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsEditing(true)}
                    >
                        <Pencil className="w-4 h-4 mr-1" />
                        Edit
                    </Button>
                ) : null}
            </div>

            {/* Current Usage Section (Read-only).
                Prefer the live computed totals from the transfers ledger
                (served by GET /v1/wallets/:id as dailyActualSpent /
                monthlyActualSpent). This works for every wallet type,
                including ones that never update the spending_policy JSON
                counters (agent_eoa, external, smart_wallet). Falls back
                to the JSON counters for legacy wallets that only ship
                those. */}
            <div className="space-y-4 mb-6">
                <div className="text-sm font-medium text-muted-foreground mb-3">
                    Current Usage
                </div>
                <SpendingProgress
                    label="Daily Limit"
                    spent={
                        (wallet as any).dailyActualSpent != null
                            ? (wallet as any).dailyActualSpent
                            : (policy.dailySpent || 0)
                    }
                    limit={policy.dailySpendLimit}
                    currency={wallet.currency || 'USD'}
                    resetAt={policy.dailyResetAt}
                    showReset
                />
                <SpendingProgress
                    label="Monthly Limit"
                    spent={
                        (wallet as any).monthlyActualSpent != null
                            ? (wallet as any).monthlyActualSpent
                            : (policy.monthlySpent || 0)
                    }
                    limit={policy.monthlySpendLimit}
                    currency={wallet.currency || 'USD'}
                    resetAt={policy.monthlyResetAt}
                    showReset
                />
            </div>

            {/* Edit Mode */}
            {isEditing && (
                <div className="border-t border-gray-200 dark:border-gray-700 pt-6 space-y-6">
                    {/* Spending Limits */}
                    <div>
                        <div className="text-sm font-medium mb-3">Spending Limits</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <Label htmlFor="dailyLimit" className="text-sm">
                                    Daily Limit
                                </Label>
                                <div className="relative mt-1">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                        $
                                    </span>
                                    <Input
                                        id="dailyLimit"
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        placeholder="1000"
                                        value={formData.dailySpendLimit}
                                        onChange={(e) => setFormData(prev => ({
                                            ...prev,
                                            dailySpendLimit: e.target.value
                                        }))}
                                        className="pl-7"
                                    />
                                </div>
                            </div>
                            <div>
                                <Label htmlFor="monthlyLimit" className="text-sm">
                                    Monthly Limit
                                </Label>
                                <div className="relative mt-1">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                        $
                                    </span>
                                    <Input
                                        id="monthlyLimit"
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        placeholder="5000"
                                        value={formData.monthlySpendLimit}
                                        onChange={(e) => setFormData(prev => ({
                                            ...prev,
                                            monthlySpendLimit: e.target.value
                                        }))}
                                        className="pl-7"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Approval Threshold */}
                    <div>
                        <Label htmlFor="approvalThreshold" className="text-sm font-medium">
                            Approval Threshold
                        </Label>
                        <div className="relative mt-1">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                $
                            </span>
                            <Input
                                id="approvalThreshold"
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="500"
                                value={formData.requiresApprovalAbove}
                                onChange={(e) => setFormData(prev => ({
                                    ...prev,
                                    requiresApprovalAbove: e.target.value
                                }))}
                                className="pl-7"
                            />
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                            <Info className="w-3 h-3 mt-0.5 shrink-0" />
                            Payments above this amount will require manual approval
                        </p>
                    </div>

                    {/* Approved Vendors */}
                    <div>
                        <Label className="text-sm font-medium">
                            Approved Vendors (optional)
                        </Label>
                        <div className="flex flex-wrap gap-2 mt-2 mb-2">
                            {formData.approvedVendors.map((vendor) => (
                                <span
                                    key={vendor}
                                    className="inline-flex items-center gap-1 px-2 py-1 bg-secondary text-secondary-foreground rounded-md text-sm"
                                >
                                    {vendor}
                                    <button
                                        type="button"
                                        onClick={() => removeVendor(vendor)}
                                        className="hover:text-destructive"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <Input
                                placeholder="e.g., api.openai.com"
                                value={newVendor}
                                onChange={(e) => setNewVendor(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        addVendor();
                                    }
                                }}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={addVendor}
                            >
                                <Plus className="w-4 h-4" />
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                            <Info className="w-3 h-3 mt-0.5 shrink-0" />
                            Leave empty to allow all vendors
                        </p>
                    </div>

                    {/* Approved Endpoints (for x402 wallets) */}
                    {wallet.purpose === 'x402' && (
                        <div>
                            <Label className="text-sm font-medium">
                                Approved Endpoints (optional)
                            </Label>
                            <div className="flex flex-wrap gap-2 mt-2 mb-2">
                                {formData.approvedEndpoints.map((endpoint) => (
                                    <span
                                        key={endpoint}
                                        className="inline-flex items-center gap-1 px-2 py-1 bg-secondary text-secondary-foreground rounded-md text-sm font-mono"
                                    >
                                        {endpoint}
                                        <button
                                            type="button"
                                            onClick={() => removeEndpoint(endpoint)}
                                            className="hover:text-destructive"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <div className="flex gap-2">
                                <Input
                                    placeholder="Endpoint ID"
                                    value={newEndpoint}
                                    onChange={(e) => setNewEndpoint(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            addEndpoint();
                                        }
                                    }}
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={addEndpoint}
                                >
                                    <Plus className="w-4 h-4" />
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                                Restrict payments to specific x402 endpoints
                            </p>
                        </div>
                    )}

                    {/* Auto-Fund Settings */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-sm font-medium">
                                    Auto-Fund
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    Automatically fund wallet when balance drops
                                </p>
                            </div>
                            <Switch
                                checked={formData.autoFundEnabled}
                                onCheckedChange={(checked) => setFormData(prev => ({
                                    ...prev,
                                    autoFundEnabled: checked
                                }))}
                            />
                        </div>

                        {formData.autoFundEnabled && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-4 border-l-2 border-primary/20">
                                <div>
                                    <Label htmlFor="autoFundThreshold" className="text-sm">
                                        When balance drops below
                                    </Label>
                                    <div className="relative mt-1">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                            $
                                        </span>
                                        <Input
                                            id="autoFundThreshold"
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            placeholder="100"
                                            value={formData.autoFundThreshold}
                                            onChange={(e) => setFormData(prev => ({
                                                ...prev,
                                                autoFundThreshold: e.target.value
                                            }))}
                                            className="pl-7"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <Label htmlFor="autoFundAmount" className="text-sm">
                                        Auto-fund amount
                                    </Label>
                                    <div className="relative mt-1">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                            $
                                        </span>
                                        <Input
                                            id="autoFundAmount"
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            placeholder="500"
                                            value={formData.autoFundAmount}
                                            onChange={(e) => setFormData(prev => ({
                                                ...prev,
                                                autoFundAmount: e.target.value
                                            }))}
                                            className="pl-7"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Action Buttons */}
                    <div className="flex justify-end gap-2 pt-4 border-t border-gray-200 dark:border-gray-700">
                        <Button variant="outline" onClick={handleCancel}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => updateMutation.mutate()}
                            disabled={updateMutation.isPending}
                        >
                            {updateMutation.isPending ? (
                                "Saving..."
                            ) : (
                                <>
                                    <Save className="w-4 h-4 mr-1" />
                                    Save Changes
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            )}

            {/* Display summary when not editing */}
            {!isEditing && (
                <div className="space-y-3 text-sm">
                    {(policy.requiresApprovalAbove || policy.approvalThreshold) && (
                        <div className="flex justify-between py-2 border-t border-gray-100 dark:border-gray-800">
                            <span className="text-muted-foreground">Approval Threshold</span>
                            <span className="font-medium">
                                ${(policy.requiresApprovalAbove ?? policy.approvalThreshold)?.toLocaleString()}
                            </span>
                        </div>
                    )}
                    {policy.approvedVendors && policy.approvedVendors.length > 0 && (
                        <div className="py-2 border-t border-gray-100 dark:border-gray-800">
                            <span className="text-muted-foreground block mb-2">Approved Vendors</span>
                            <div className="flex flex-wrap gap-1">
                                {policy.approvedVendors.map((vendor) => (
                                    <span
                                        key={vendor}
                                        className="px-2 py-0.5 bg-secondary text-secondary-foreground rounded text-xs"
                                    >
                                        {vendor}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {policy.autoFundEnabled && (
                        <div className="flex justify-between py-2 border-t border-gray-100 dark:border-gray-800">
                            <span className="text-muted-foreground">Auto-Fund</span>
                            <span className="text-green-600 dark:text-green-400 text-xs">
                                Enabled (below ${policy.autoFundThreshold?.toLocaleString()} -&gt; add ${policy.autoFundAmount?.toLocaleString()})
                            </span>
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}
