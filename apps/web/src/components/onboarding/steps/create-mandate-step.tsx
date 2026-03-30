'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, CheckCircle, Info, Calendar, DollarSign } from 'lucide-react';
import { cn } from '@sly/ui';
import { useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';

interface CreateMandateStepProps {
  agentId?: string;
  onMandateCreated: (mandateId: string) => void;
  helpText?: string;
}

const FREQUENCIES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

export function CreateMandateStep({
  agentId,
  onMandateCreated,
  helpText = 'Mandates authorize the agent to make recurring payments within defined rules.',
}: CreateMandateStepProps) {
  const { authToken, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    name: '',
    amount: '99.00',
    frequency: 'monthly',
    startDate: new Date().toISOString().split('T')[0],
    endDate: '',
    maxExecutions: '',
  });

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdMandate, setCreatedMandate] = useState<{
    id: string;
    name: string;
    amount: number;
    frequency: string;
  } | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/v1/ap2/mandates`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentId: agentId,
          name: formData.name,
          amount: parseFloat(formData.amount),
          frequency: formData.frequency,
          startDate: formData.startDate,
          endDate: formData.endDate || undefined,
          maxExecutions: formData.maxExecutions ? parseInt(formData.maxExecutions) : undefined,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create mandate');
      }

      const result = await response.json();
      const mandate = result.data || result;

      setCreatedMandate({
        id: mandate.id,
        name: mandate.name || formData.name,
        amount: parseFloat(formData.amount),
        frequency: formData.frequency,
      });

      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ['mandates'] });
      queryClient.invalidateQueries({ queryKey: ['onboarding-state'] });

      toast.success('Mandate created successfully!');
      onMandateCreated(mandate.id);
    } catch (err: any) {
      setError(err.message || 'Failed to create mandate');
      toast.error('Failed to create mandate');
    } finally {
      setIsCreating(false);
    }
  };

  if (createdMandate) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
            Mandate Created!
          </h3>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            Your recurring payment mandate is now active
          </p>
        </div>

        <div className="bg-gray-50 dark:bg-gray-900/50 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Mandate Name</span>
            <span className="font-medium text-gray-900 dark:text-white">{createdMandate.name}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Amount</span>
            <span className="font-medium text-gray-900 dark:text-white">
              ${createdMandate.amount.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Frequency</span>
            <span className="font-medium text-gray-900 dark:text-white capitalize">
              {createdMandate.frequency}
            </span>
          </div>
        </div>

        <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-medium text-blue-800 dark:text-blue-200 text-sm">
                How Mandates Work
              </h4>
              <ul className="text-xs text-blue-700 dark:text-blue-300 mt-1 space-y-1">
                <li>• Agent can only charge exactly this amount</li>
                <li>• Cannot exceed the set frequency</li>
                <li>• Auto-expires on end date (if set)</li>
              </ul>
            </div>
          </div>
        </div>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-6">
          Click <strong>Continue</strong> to proceed to the next step
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto">
      {/* Help tip */}
      <div className="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl mb-6">
        <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-blue-800 dark:text-blue-200">{helpText}</p>
      </div>

      <form onSubmit={handleCreate} className="space-y-6">
        {error && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Mandate Name
          </label>
          <input
            type="text"
            required
            value={formData.name}
            onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
            placeholder="e.g., Monthly API Subscription"
            className="w-full px-4 py-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Amount
            </label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="number"
                required
                step="0.01"
                min="0.01"
                value={formData.amount}
                onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                className="w-full pl-9 pr-4 py-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Frequency
            </label>
            <select
              value={formData.frequency}
              onChange={(e) => setFormData(prev => ({ ...prev, frequency: e.target.value }))}
              className="w-full px-4 py-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {FREQUENCIES.map((freq) => (
                <option key={freq.value} value={freq.value}>{freq.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Start Date
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="date"
                required
                value={formData.startDate}
                onChange={(e) => setFormData(prev => ({ ...prev, startDate: e.target.value }))}
                className="w-full pl-9 pr-4 py-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              End Date (Optional)
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="date"
                value={formData.endDate}
                onChange={(e) => setFormData(prev => ({ ...prev, endDate: e.target.value }))}
                min={formData.startDate}
                className="w-full pl-9 pr-4 py-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Max Executions (Optional)
          </label>
          <input
            type="number"
            min="1"
            value={formData.maxExecutions}
            onChange={(e) => setFormData(prev => ({ ...prev, maxExecutions: e.target.value }))}
            placeholder="e.g., 12 for yearly subscription"
            className="w-full px-4 py-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Leave empty for unlimited executions
          </p>
        </div>

        <button
          type="submit"
          disabled={isCreating || !formData.name || !formData.amount}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Creating Mandate...
            </>
          ) : (
            <>
              <FileText className="w-5 h-5" />
              Create Mandate
            </>
          )}
        </button>
      </form>
    </div>
  );
}
