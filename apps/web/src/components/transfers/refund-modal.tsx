'use client';

import { useState, useEffect } from 'react';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { X, AlertCircle, Loader2, ArrowLeft, Eye, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button, Input, Label, cn } from '@sly/ui';
import type { Transfer, RefundReason } from '@sly/api-client';
import { formatCurrency } from '@sly/ui';

interface RefundModalProps {
  transfer: Transfer;
  onClose: () => void;
  onSuccess: () => void;
}

const REFUND_REASONS: { value: RefundReason; label: string; description: string }[] = [
  { value: 'customer_request', label: 'Customer Request', description: 'Customer asked for a refund' },
  { value: 'duplicate_payment', label: 'Duplicate Payment', description: 'Payment was made twice' },
  { value: 'service_not_rendered', label: 'Service Not Rendered', description: 'Service/goods not delivered' },
  { value: 'error', label: 'Processing Error', description: 'Error in payment processing' },
  { value: 'other', label: 'Other', description: 'Other reason' },
];

export function RefundModal({ transfer, onClose, onSuccess }: RefundModalProps) {
  const api = useApiClient();
  const { apiUrl } = useApiConfig();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [isPartial, setIsPartial] = useState(false);
  const [amount, setAmount] = useState(String(transfer.amount));
  const [reason, setReason] = useState<RefundReason>('customer_request');
  const [reasonDetails, setReasonDetails] = useState('');
  
  // Simulation state
  const [simulation, setSimulation] = useState<any>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  // Auto-simulate on amount change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isValidAmount) {
        simulateRefund();
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [amount, isPartial]);

  const simulateRefund = async () => {
    setIsSimulating(true);
    setSimulationError(null);

    try {
      // Get auth token from Supabase session
      const supabase = await import('@/lib/supabase/client').then(m => m.createSupabaseBrowserClient());
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`${apiUrl}/v1/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          action: 'refund',
          payload: {
            transfer_id: transfer.id,
            amount: refundAmount.toString(),
            reason,
          },
        }),
      });

      const data = await response.json();

      if (data.success) {
        setSimulation(data.data);
      } else {
        setSimulationError(data.error?.message || 'Simulation failed');
      }
    } catch (err: any) {
      setSimulationError(err.message || 'Failed to simulate refund');
    } finally {
      setIsSimulating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;

    setLoading(true);
    setError(null);

    try {
      await api.refunds.create({
        originalTransferId: transfer.id,
        amount: isPartial ? parseFloat(amount) : undefined,
        reason,
        reasonDetails: reasonDetails || undefined,
      });
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to process refund');
    } finally {
      setLoading(false);
    }
  };

  const refundAmount = isPartial ? parseFloat(amount) || 0 : transfer.amount;
  const isValidAmount = refundAmount > 0 && refundAmount <= transfer.amount;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-amber-100 dark:bg-amber-950 rounded-xl flex items-center justify-center">
              <ArrowLeft className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Issue Refund</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Transfer #{transfer.id.slice(0, 8)}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg flex items-center gap-2 text-red-700 dark:text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Original Transaction Info */}
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Original Amount</span>
              <span className="font-medium text-gray-900 dark:text-white">
                {formatCurrency(transfer.amount, transfer.currency)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">From</span>
              <span className="text-gray-700 dark:text-gray-300">{transfer.from?.accountName || 'External'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">To</span>
              <span className="text-gray-700 dark:text-gray-300">{transfer.to?.accountName || 'External'}</span>
            </div>
          </div>

          {/* Refund Type */}
          <div>
            <Label className="text-sm font-medium text-gray-900 dark:text-white mb-2 block">
              Refund Type
            </Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsPartial(false)}
                className={cn(
                  "flex-1 py-2.5 px-4 rounded-lg text-sm font-medium border transition-colors",
                  !isPartial
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-400"
                )}
              >
                Full Refund
              </button>
              <button
                type="button"
                onClick={() => setIsPartial(true)}
                className={cn(
                  "flex-1 py-2.5 px-4 rounded-lg text-sm font-medium border transition-colors",
                  isPartial
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-400"
                )}
              >
                Partial Refund
              </button>
            </div>
          </div>

          {/* Amount (if partial) */}
          {isPartial && (
            <div>
              <Label htmlFor="amount" className="text-sm font-medium text-gray-900 dark:text-white mb-2 block">
                Refund Amount
              </Label>
              <div className="relative">
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={transfer.amount}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="pl-10"
                  placeholder="0.00"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                  {transfer.currency}
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Max: {formatCurrency(transfer.amount, transfer.currency)}
              </p>
            </div>
          )}

          {/* Reason */}
          <div>
            <Label htmlFor="reason" className="text-sm font-medium text-gray-900 dark:text-white mb-2 block">
              Reason
            </Label>
            <select
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as RefundReason)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {REFUND_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label} - {r.description}
                </option>
              ))}
            </select>
          </div>

          {/* Additional Details */}
          <div>
            <Label htmlFor="details" className="text-sm font-medium text-gray-900 dark:text-white mb-2 block">
              Additional Details (Optional)
            </Label>
            <textarea
              id="details"
              value={reasonDetails}
              onChange={(e) => setReasonDetails(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={3}
              placeholder="Any additional information..."
            />
          </div>

          {/* Simulation Preview */}
          {isSimulating && (
            <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-xl p-4">
              <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Validating refund...</span>
              </div>
            </div>
          )}

          {simulation && !isSimulating && (
            <div className="space-y-3">
              {/* Eligibility Status */}
              <div className={cn(
                "rounded-xl p-4 border",
                simulation.can_execute
                  ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900"
                  : "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900"
              )}>
                <div className="flex items-center gap-2">
                  {simulation.can_execute ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                  )}
                  <span className={cn(
                    "text-sm font-medium",
                    simulation.can_execute
                      ? "text-green-900 dark:text-green-200"
                      : "text-red-900 dark:text-red-200"
                  )}>
                    {simulation.can_execute ? 'Refund Eligible' : 'Refund Not Eligible'}
                  </span>
                </div>
                {simulation.preview?.eligibility && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    Window expires in {simulation.preview.eligibility.days_remaining} days
                  </p>
                )}
              </div>

              {/* Warnings */}
              {simulation.warnings?.length > 0 && (
                <div className="bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-900 rounded-xl p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-yellow-900 dark:text-yellow-200">Warnings</div>
                      <ul className="text-xs text-yellow-700 dark:text-yellow-400 mt-1 space-y-1">
                        {simulation.warnings.map((w: any, i: number) => (
                          <li key={i}>• {w.message}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Errors */}
              {simulation.errors?.length > 0 && (
                <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-xl p-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-red-900 dark:text-red-200">Errors</div>
                      <ul className="text-xs text-red-700 dark:text-red-400 mt-1 space-y-1">
                        {simulation.errors.map((e: any, i: number) => (
                          <li key={i}>• {e.message}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Balance Impact */}
              {simulation.preview?.balance_impact && (
                <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
                  <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Balance Impact</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-500 dark:text-gray-400">Source after refund</span>
                      <span className="font-medium text-gray-900 dark:text-white">
                        {formatCurrency(parseFloat(simulation.preview.balance_impact.source_balance_after), transfer.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 dark:text-gray-400">Destination after refund</span>
                      <span className="font-medium text-gray-900 dark:text-white">
                        {formatCurrency(parseFloat(simulation.preview.balance_impact.destination_balance_after), transfer.currency)}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {simulationError && (
            <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-xl p-3">
              <div className="flex items-center gap-2 text-red-700 dark:text-red-400 text-sm">
                <AlertCircle className="h-4 w-4" />
                {simulationError}
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-xl p-4">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-amber-900 dark:text-amber-200">Refund Amount</span>
              <span className="text-lg font-bold text-amber-900 dark:text-amber-200">
                {formatCurrency(refundAmount, transfer.currency)}
              </span>
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              Funds will be returned to the original sender
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={loading || !isValidAmount || (simulation && !simulation.can_execute)}
              className="flex-1 bg-amber-600 hover:bg-amber-700"
            >
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Issue Refund
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

