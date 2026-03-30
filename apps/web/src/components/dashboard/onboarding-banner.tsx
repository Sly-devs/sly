'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Rocket, CheckCircle, ChevronRight, X, Sparkles, PartyPopper } from 'lucide-react';
import { useApiConfig, useApiFetch, type ApiFetchFn } from '@/lib/api-client';
import { useEnvironment } from '@/lib/environment-context';
import { cn } from '@sly/ui';
import Link from 'next/link';

const STORAGE_KEY_DISMISSED = 'payos_onboarding_dismissed';
const STORAGE_KEY_COMPLETE = 'payos_onboarding_complete';
const CELEBRATION_DURATION_MS = 3000;

interface TenantOnboardingState {
  tenant_id: string;
  overall_progress: number;
  has_any_protocol_enabled: boolean;
  has_payment_handler: boolean;
  has_wallet: boolean;
  sandbox_mode: boolean;
}

async function fetchOnboardingState(apiFetch: ApiFetchFn, apiUrl: string): Promise<TenantOnboardingState> {
  const response = await apiFetch(
    `${apiUrl}/v1/onboarding`
  );
  if (!response.ok) {
    throw new Error('Failed to fetch onboarding state');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  const data = json.data || json;
  return data;
}

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  link: string;
}

export function OnboardingBanner() {
  const { authToken, isConfigured, apiEnvironment, apiUrl } = useApiConfig();
  const { environment } = useEnvironment();
  const apiFetch = useApiFetch();
  const [dismissed, setDismissed] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationComplete, setCelebrationComplete] = useState(false);

  // Check localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isDismissed = localStorage.getItem(STORAGE_KEY_DISMISSED) === 'true';
      const isComplete = localStorage.getItem(STORAGE_KEY_COMPLETE) === 'true';
      if (isDismissed || isComplete) {
        setDismissed(true);
      }
    }
  }, []);

  const { data: onboardingState, isLoading } = useQuery({
    queryKey: ['onboarding-state-banner', apiEnvironment],
    queryFn: () => fetchOnboardingState(apiFetch, apiUrl),
    enabled: !!authToken && isConfigured,
    staleTime: 60 * 1000,
  });

  // Build steps based on onboarding state
  const steps: OnboardingStep[] = onboardingState
    ? [
        {
          id: 'connect',
          title: 'Connect Payment Account',
          description: 'Link Stripe, PayPal, or create a wallet',
          completed: onboardingState.has_payment_handler || onboardingState.has_wallet,
          link: onboardingState.has_wallet ? '/dashboard/wallets' : '/dashboard/payment-handlers',
        },
        {
          id: 'enable',
          title: 'Enable Protocol',
          description: 'Choose x402, AP2, ACP, or UCP',
          completed: onboardingState.has_any_protocol_enabled,
          link: '/dashboard/protocols',
        },
        {
          id: 'configure',
          title: 'Configure Protocol',
          description: 'Complete your protocol setup',
          completed: onboardingState.overall_progress >= 50,
          link: '/dashboard/onboarding',
        },
      ]
    : [];

  const completedSteps = steps.filter((s) => s.completed).length;
  const currentStep = steps.find((s) => !s.completed);
  const isComplete = completedSteps === 3;

  // Handle celebration when all steps complete
  useEffect(() => {
    if (isComplete && !celebrationComplete && !dismissed) {
      setShowCelebration(true);

      const timer = setTimeout(() => {
        // Mark as complete in localStorage
        if (typeof window !== 'undefined') {
          localStorage.setItem(STORAGE_KEY_COMPLETE, 'true');
        }
        setCelebrationComplete(true);
        setDismissed(true);
      }, CELEBRATION_DURATION_MS);

      return () => clearTimeout(timer);
    }
  }, [isComplete, celebrationComplete, dismissed]);

  // Handle dismiss
  const handleDismiss = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_DISMISSED, 'true');
    }
    setDismissed(true);
  };

  // Don't show if dismissed, loading, or no data
  if (dismissed || isLoading || !onboardingState) {
    return null;
  }

  // New user - show welcome banner
  if (onboardingState.overall_progress === 0) {
    return (
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-6 text-white mb-6 relative overflow-hidden">
        {/* Background decoration */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/10 rounded-full translate-y-1/2 -translate-x-1/2" />

        <div className="relative z-10">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center">
                <Rocket className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-xl font-bold mb-1">Welcome to Sly!</h2>
                <p className="text-blue-100">
                  Complete these steps to start accepting agentic payments
                </p>
              </div>
            </div>
            <button
              onClick={handleDismiss}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Dismiss banner"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
            {steps.map((step, index) => (
              <Link
                key={step.id}
                href={step.link}
                className={cn(
                  'bg-white/10 hover:bg-white/20 rounded-xl p-4 transition-colors',
                  step.completed && 'bg-white/5'
                )}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold',
                      step.completed
                        ? 'bg-green-500 text-white'
                        : 'bg-white/20 text-white'
                    )}
                  >
                    {step.completed ? (
                      <CheckCircle className="w-5 h-5" />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <span className="font-medium">{step.title}</span>
                </div>
                <p className="text-sm text-blue-100 ml-11">{step.description}</p>
              </Link>
            ))}
          </div>

          <div className="mt-6 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-blue-100">
              <Sparkles className="w-4 h-4" />
              <span>
                {environment === 'sandbox'
                  ? 'Sandbox mode active - test without real payments'
                  : 'Production mode - transactions use real funds'}
              </span>
            </div>
            <Link
              href="/dashboard/onboarding"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white text-blue-600 font-medium rounded-lg hover:bg-blue-50 transition-colors"
            >
              Start Setup
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Show celebration banner when all complete
  if (showCelebration) {
    return (
      <div className="bg-gradient-to-r from-emerald-500 to-green-600 rounded-2xl p-5 text-white mb-6 animate-in fade-in slide-in-from-top-2 duration-300">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center animate-bounce">
              <PartyPopper className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-semibold text-lg">All done!</h3>
                <span className="px-2 py-0.5 bg-white/20 text-xs font-medium rounded-full">
                  {completedSteps}/{steps.length} complete
                </span>
              </div>
              <p className="text-green-100 text-sm">
                Setup complete. You're ready to accept agentic payments!
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/onboarding"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-white/20 hover:bg-white/30 text-white text-sm font-medium rounded-lg transition-colors"
            >
              View Templates
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // In progress - show compact progress banner
  return (
    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl p-5 border border-blue-200 dark:border-blue-900 mb-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900 rounded-xl flex items-center justify-center">
            <Rocket className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-gray-900 dark:text-white">
                Continue Setup
              </h3>
              <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs font-medium rounded-full">
                {completedSteps}/{steps.length} complete
              </span>
            </div>
            {currentStep && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Next: {currentStep.title}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Progress dots */}
          <div className="hidden sm:flex items-center gap-2">
            {steps.map((step) => (
              <div
                key={step.id}
                className={cn(
                  'w-3 h-3 rounded-full transition-colors',
                  step.completed
                    ? 'bg-green-500'
                    : 'bg-gray-300 dark:bg-gray-700'
                )}
              />
            ))}
          </div>

          <Link
            href={currentStep?.link || '/dashboard/onboarding'}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Continue
            <ChevronRight className="w-4 h-4" />
          </Link>

          <button
            onClick={handleDismiss}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            aria-label="Dismiss banner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
