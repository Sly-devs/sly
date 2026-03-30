'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap,
  Shield,
  ShoppingCart,
  Globe,
  CheckCircle,
  Circle,
  SkipForward,
  RotateCcw,
  ChevronRight,
  Loader2,
  Play,
  Rocket,
  ShoppingBag,
  Bot,
  Repeat,
  FlaskConical,
  AlertCircle,
  Power,
  ArrowRight,
} from 'lucide-react';
import { useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import { cn } from '@sly/ui';
import Link from 'next/link';
import {
  hasInProgressWizard,
  getWizardProgressPercent,
  useAllWizardProgress,
} from '@/hooks/useWizardProgress';
import { WIZARD_TEMPLATES, LEGACY_TEMPLATE_MAP, type TemplateId } from '@/types/wizard';

// Types
type ProtocolId = 'x402' | 'ap2' | 'acp' | 'ucp';
type OnboardingStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  status: OnboardingStepStatus;
  action_url?: string;
  action_label?: string;
}

interface ProtocolOnboardingState {
  protocol_id: ProtocolId;
  protocol_name: string;
  enabled: boolean;
  prerequisites_met: boolean;
  steps: OnboardingStep[];
  current_step: number;
  total_steps: number;
  completed_steps: number;
  progress_percentage: number;
  is_complete: boolean;
}

interface QuickStartTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  protocols: ProtocolId[];
  steps: { title: string; description: string; action_url: string }[];
  estimated_time: string;
}

interface TenantOnboardingState {
  tenant_id: string;
  overall_progress: number;
  has_any_protocol_enabled: boolean;
  has_payment_handler: boolean;
  has_wallet: boolean;
  protocols: Record<ProtocolId, ProtocolOnboardingState>;
  recommended_template?: QuickStartTemplate;
  sandbox_mode: boolean;
}

// Protocol UI metadata
const PROTOCOL_UI: Record<ProtocolId, { icon: typeof Zap; color: string; gradient: string; bgColor: string }> = {
  x402: {
    icon: Zap,
    color: 'text-yellow-600 dark:text-yellow-400',
    gradient: 'from-yellow-500/10 to-orange-500/10',
    bgColor: 'bg-yellow-100 dark:bg-yellow-950',
  },
  ap2: {
    icon: Shield,
    color: 'text-blue-600 dark:text-blue-400',
    gradient: 'from-blue-500/10 to-indigo-500/10',
    bgColor: 'bg-blue-100 dark:bg-blue-950',
  },
  acp: {
    icon: ShoppingCart,
    color: 'text-purple-600 dark:text-purple-400',
    gradient: 'from-purple-500/10 to-pink-500/10',
    bgColor: 'bg-purple-100 dark:bg-purple-950',
  },
  ucp: {
    icon: Globe,
    color: 'text-green-600 dark:text-green-400',
    gradient: 'from-green-500/10 to-emerald-500/10',
    bgColor: 'bg-green-100 dark:bg-green-950',
  },
};

const TEMPLATE_ICONS: Record<string, typeof Rocket> = {
  'zap': Rocket,
  'shopping-cart': ShoppingBag,
  'bot': Bot,
  'repeat': Repeat,
};

// API functions
async function fetchOnboardingState(authToken: string, apiUrl: string): Promise<TenantOnboardingState> {
  const response = await fetch(`${apiUrl}/v1/onboarding`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch onboarding state');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function fetchTemplates(authToken: string, apiUrl: string): Promise<{ data: QuickStartTemplate[] }> {
  const response = await fetch(`${apiUrl}/v1/onboarding/templates`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch templates');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function completeStep(
  authToken: string,
  apiUrl: string,
  protocolId: ProtocolId,
  stepId: string
): Promise<ProtocolOnboardingState> {
  const response = await fetch(
    `${apiUrl}/v1/onboarding/protocols/${protocolId}/steps/${stepId}/complete`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!response.ok) {
    throw new Error('Failed to complete step');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function skipStep(
  authToken: string,
  apiUrl: string,
  protocolId: ProtocolId,
  stepId: string
): Promise<ProtocolOnboardingState> {
  const response = await fetch(
    `${apiUrl}/v1/onboarding/protocols/${protocolId}/steps/${stepId}/skip`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!response.ok) {
    throw new Error('Failed to skip step');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function resetOnboarding(
  authToken: string,
  apiUrl: string,
  protocolId: ProtocolId
): Promise<ProtocolOnboardingState> {
  const response = await fetch(
    `${apiUrl}/v1/onboarding/protocols/${protocolId}/reset`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!response.ok) {
    throw new Error('Failed to reset onboarding');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function toggleSandboxMode(
  authToken: string,
  apiUrl: string,
  enabled: boolean
): Promise<{ success: boolean; sandbox_mode: boolean }> {
  const response = await fetch(`${apiUrl}/v1/onboarding/sandbox`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error('Failed to toggle sandbox mode');
  }
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

async function enableProtocol(
  authToken: string,
  apiUrl: string,
  protocolId: ProtocolId
): Promise<{ success: boolean; error?: string; missing_prerequisites?: string[] }> {
  const response = await fetch(
    `${apiUrl}/v1/organization/protocols/${protocolId}/enable`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const json = await response.json();
  // Handle wrapped response format: { success: true, data: {...} }
  return json.data || json;
}

// Progress ring component
function ProgressRing({ progress, size = 120, strokeWidth = 8 }: { progress: number; size?: number; strokeWidth?: number }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (progress / 100) * circumference;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-gray-200 dark:text-gray-800"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="text-green-500 dark:text-green-400 transition-all duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-2xl font-bold text-gray-900 dark:text-white">{progress}%</span>
      </div>
    </div>
  );
}

// Step item component
function StepItem({
  step,
  index,
  isCurrent,
  onComplete,
  onSkip,
  isLoading,
}: {
  step: OnboardingStep;
  index: number;
  isCurrent: boolean;
  onComplete: () => void;
  onSkip: () => void;
  isLoading: boolean;
}) {
  const isCompleted = step.status === 'completed';
  const isSkipped = step.status === 'skipped';

  return (
    <div
      className={cn(
        'flex items-start gap-4 p-4 rounded-xl transition-colors',
        isCurrent && 'bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800',
        !isCurrent && 'hover:bg-gray-50 dark:hover:bg-gray-900/50'
      )}
    >
      {/* Step number/icon */}
      <div className="flex-shrink-0">
        {isCompleted ? (
          <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-950 flex items-center justify-center">
            <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
          </div>
        ) : isSkipped ? (
          <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
            <SkipForward className="w-4 h-4 text-gray-400" />
          </div>
        ) : (
          <div
            className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
              isCurrent
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
            )}
          >
            {index + 1}
          </div>
        )}
      </div>

      {/* Step content */}
      <div className="flex-1 min-w-0">
        <h4
          className={cn(
            'font-medium',
            isCompleted || isSkipped
              ? 'text-gray-500 dark:text-gray-400'
              : 'text-gray-900 dark:text-white'
          )}
        >
          {step.title}
        </h4>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          {step.description}
        </p>

        {/* Action buttons */}
        {isCurrent && !isCompleted && !isSkipped && (
          <div className="flex items-center gap-2 mt-3">
            {step.action_url && (
              <Link
                href={step.action_url}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                {step.action_label || 'Start'}
              </Link>
            )}
            <button
              onClick={onComplete}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {isLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle className="w-3.5 h-3.5" />
              )}
              Mark Complete
            </button>
            <button
              onClick={onSkip}
              disabled={isLoading}
              className="inline-flex items-center gap-1 px-2 py-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 text-sm transition-colors disabled:opacity-50"
            >
              Skip
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Protocol onboarding card component
function ProtocolOnboardingCard({
  state,
  onCompleteStep,
  onSkipStep,
  onReset,
  onEnable,
  isLoading,
  isEnabling,
}: {
  state: ProtocolOnboardingState;
  onCompleteStep: (stepId: string) => void;
  onSkipStep: (stepId: string) => void;
  onReset: () => void;
  onEnable: () => void;
  isLoading: boolean;
  isEnabling: boolean;
}) {
  const ui = PROTOCOL_UI[state.protocol_id];
  const Icon = ui.icon;
  const [expanded, setExpanded] = useState(state.enabled && !state.is_complete);

  return (
    <div
      className={cn(
        'bg-white dark:bg-gray-950 rounded-2xl border overflow-hidden',
        'border-gray-200 dark:border-gray-800'
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'p-6 transition-colors',
          state.enabled ? 'cursor-pointer' : '',
          state.enabled && !expanded ? 'hover:bg-gray-50 dark:hover:bg-gray-900/50' : ''
        )}
        onClick={() => state.enabled && setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center', ui.bgColor)}>
              <Icon className={cn('w-6 h-6', ui.color)} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">
                {state.protocol_name}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                {state.enabled ? (
                  <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                    Enabled
                  </span>
                ) : state.prerequisites_met ? (
                  <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                    Ready to enable
                  </span>
                ) : (
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    Prerequisites required
                  </span>
                )}
                {state.is_complete && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 dark:bg-green-950 text-green-600 dark:text-green-400 text-xs font-medium rounded-full">
                    <CheckCircle className="w-3 h-3" />
                    Complete
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {state.enabled ? (
              <>
                {/* Progress bar - only show when enabled */}
                <div className="hidden sm:flex items-center gap-3">
                  <div className="w-32 h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all duration-500', ui.bgColor.replace('bg-', 'bg-').replace('100', '500').replace('950', '500'))}
                      style={{ width: `${state.progress_percentage}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                    {state.completed_steps}/{state.total_steps}
                  </span>
                </div>

                <ChevronRight
                  className={cn(
                    'w-5 h-5 text-gray-400 transition-transform',
                    expanded && 'rotate-90'
                  )}
                />
              </>
            ) : (
              /* Enable button - show when not enabled */
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEnable();
                }}
                disabled={isEnabling || !state.prerequisites_met}
                className={cn(
                  'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  state.prerequisites_met
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-400 cursor-not-allowed'
                )}
              >
                {isEnabling ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Power className="w-4 h-4" />
                )}
                {isEnabling ? 'Enabling...' : 'Enable Protocol'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Steps - only show when enabled and expanded */}
      {state.enabled && expanded && (
        <div className="px-6 pb-6 space-y-2">
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
            {state.steps.map((step, index) => (
              <StepItem
                key={step.id}
                step={step}
                index={index}
                isCurrent={index === state.current_step && !state.is_complete}
                onComplete={() => onCompleteStep(step.id)}
                onSkip={() => onSkipStep(step.id)}
                isLoading={isLoading}
              />
            ))}
          </div>

          {/* Reset button */}
          {state.completed_steps > 0 && (
            <div className="flex justify-end pt-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onReset();
                }}
                disabled={isLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 text-sm transition-colors disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Progress
              </button>
            </div>
          )}
        </div>
      )}

      {/* Prerequisites hint - show when not enabled and prerequisites not met */}
      {!state.enabled && !state.prerequisites_met && (
        <div className="px-6 pb-6 border-t border-gray-100 dark:border-gray-800">
          <div className="pt-4 text-sm text-gray-500 dark:text-gray-400">
            <span className="font-medium text-gray-700 dark:text-gray-300">Required:</span>{' '}
            {state.protocol_id === 'x402' || state.protocol_id === 'ap2'
              ? 'Create a USDC wallet to enable this protocol'
              : 'Connect a payment handler to enable this protocol'}
          </div>
        </div>
      )}
    </div>
  );
}

// Quick start template card
function TemplateCard({
  template,
  isRecommended,
}: {
  template: QuickStartTemplate;
  isRecommended: boolean;
}) {
  const IconComponent = TEMPLATE_ICONS[template.icon] || Rocket;

  // Map template ID to wizard template ID
  const wizardTemplateId = LEGACY_TEMPLATE_MAP[template.id] || template.id as TemplateId;
  const hasProgress = hasInProgressWizard(wizardTemplateId);
  const progressPercent = getWizardProgressPercent(wizardTemplateId);
  const wizardConfig = WIZARD_TEMPLATES[wizardTemplateId];

  return (
    <div
      className={cn(
        'relative bg-white dark:bg-gray-950 rounded-2xl border p-6 transition-colors',
        hasProgress
          ? 'border-green-300 dark:border-green-700 ring-2 ring-green-100 dark:ring-green-900'
          : isRecommended
          ? 'border-blue-300 dark:border-blue-700 ring-2 ring-blue-100 dark:ring-blue-900'
          : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'
      )}
    >
      {/* Progress badge - takes priority over recommended */}
      {hasProgress && (
        <div className="absolute -top-3 left-4 px-2 py-0.5 bg-green-600 text-white text-xs font-medium rounded-full">
          {progressPercent}% Complete
        </div>
      )}
      {!hasProgress && isRecommended && (
        <div className="absolute -top-3 left-4 px-2 py-0.5 bg-blue-600 text-white text-xs font-medium rounded-full">
          Recommended
        </div>
      )}

      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
          <IconComponent className="w-6 h-6 text-gray-600 dark:text-gray-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-white">{template.name}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{template.description}</p>

          <div className="flex items-center gap-2 mt-3">
            {template.protocols.map((protocolId) => {
              const ui = PROTOCOL_UI[protocolId];
              const ProtocolIcon = ui.icon;
              return (
                <div
                  key={protocolId}
                  className={cn('w-6 h-6 rounded flex items-center justify-center', ui.bgColor)}
                  title={protocolId.toUpperCase()}
                >
                  <ProtocolIcon className={cn('w-3.5 h-3.5', ui.color)} />
                </div>
              );
            })}
            <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">
              {template.estimated_time}
            </span>
          </div>

          {/* Progress bar for in-progress wizards */}
          {hasProgress && (
            <div className="mt-3">
              <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-4">
            <Link
              href={wizardConfig ? `/dashboard/onboarding/wizard/${wizardTemplateId}` : (template.steps[0]?.action_url || '/dashboard')}
              className={cn(
                'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors',
                hasProgress
                  ? 'bg-green-600 hover:bg-green-700 text-white'
                  : 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100'
              )}
            >
              {hasProgress ? (
                <>
                  <ArrowRight className="w-4 h-4" />
                  Resume Setup
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Start Setup
                </>
              )}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// Resume Setup Card - Shows when there are in-progress wizards
function ResumeSetupCard() {
  const { wizards, refresh } = useAllWizardProgress();

  // Refresh on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (wizards.length === 0) return null;

  // Get the most recent in-progress wizard
  const mostRecent = wizards.sort(
    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  )[0];

  const templateConfig = WIZARD_TEMPLATES[mostRecent.templateId];
  if (!templateConfig) return null;

  const IconComponent = TEMPLATE_ICONS[templateConfig.icon] || Rocket;
  const progressPercent = Math.round(
    ((mostRecent.completedSteps.length + mostRecent.skippedSteps.length) /
      templateConfig.steps.length) *
      100
  );

  return (
    <div className="mb-8">
      <div className="bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl p-6 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-white/20 rounded-xl flex items-center justify-center">
              <IconComponent className="w-7 h-7 text-white" />
            </div>
            <div>
              <div className="text-sm text-green-100 mb-1">Continue where you left off</div>
              <h3 className="text-xl font-semibold">{templateConfig.name} Setup</h3>
              <div className="flex items-center gap-3 mt-2">
                <div className="flex-1 h-2 bg-white/20 rounded-full overflow-hidden max-w-[200px]">
                  <div
                    className="h-full bg-white rounded-full transition-all duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <span className="text-sm text-green-100">
                  {mostRecent.completedSteps.length + mostRecent.skippedSteps.length}/{templateConfig.steps.length} steps
                </span>
              </div>
            </div>
          </div>
          <Link
            href={`/dashboard/onboarding/wizard/${mostRecent.templateId}`}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-white text-green-700 font-medium rounded-lg hover:bg-green-50 transition-colors"
          >
            Resume
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// Main page component
export default function OnboardingPage() {
  const { isConfigured, isLoading: isAuthLoading, authToken, apiUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  // Fetch onboarding state
  const { data: onboardingState, isLoading: isLoadingState } = useQuery({
    queryKey: ['onboarding-state'],
    queryFn: () => fetchOnboardingState(authToken!, apiUrl),
    enabled: !!authToken,
  });

  // Fetch templates
  const { data: templatesData } = useQuery({
    queryKey: ['onboarding-templates'],
    queryFn: () => fetchTemplates(authToken!, apiUrl),
    enabled: !!authToken,
  });

  // Complete step mutation
  const completeStepMutation = useMutation({
    mutationFn: ({ protocolId, stepId }: { protocolId: ProtocolId; stepId: string }) =>
      completeStep(authToken!, apiUrl, protocolId, stepId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['onboarding-state'] });
      toast.success('Step completed');
      setLoadingAction(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to complete step', { description: error.message });
      setLoadingAction(null);
    },
  });

  // Skip step mutation
  const skipStepMutation = useMutation({
    mutationFn: ({ protocolId, stepId }: { protocolId: ProtocolId; stepId: string }) =>
      skipStep(authToken!, apiUrl, protocolId, stepId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['onboarding-state'] });
      toast.success('Step skipped');
      setLoadingAction(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to skip step', { description: error.message });
      setLoadingAction(null);
    },
  });

  // Reset mutation
  const resetMutation = useMutation({
    mutationFn: (protocolId: ProtocolId) => resetOnboarding(authToken!, apiUrl, protocolId),
    onSuccess: (_, protocolId) => {
      queryClient.invalidateQueries({ queryKey: ['onboarding-state'] });
      toast.success(`${protocolId.toUpperCase()} onboarding reset`);
      setLoadingAction(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to reset onboarding', { description: error.message });
      setLoadingAction(null);
    },
  });

  // Sandbox toggle mutation
  const sandboxMutation = useMutation({
    mutationFn: (enabled: boolean) => toggleSandboxMode(authToken!, apiUrl, enabled),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['onboarding-state'] });
      toast.success(result.sandbox_mode ? 'Sandbox mode enabled' : 'Sandbox mode disabled');
    },
    onError: (error: Error) => {
      toast.error('Failed to toggle sandbox mode', { description: error.message });
    },
  });

  // Enable protocol mutation
  const enableProtocolMutation = useMutation({
    mutationFn: (protocolId: ProtocolId) => enableProtocol(authToken!, apiUrl, protocolId),
    onSuccess: (result, protocolId) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ['onboarding-state'] });
        queryClient.invalidateQueries({ queryKey: ['protocol-status'] });
        toast.success(`${protocolId.toUpperCase()} protocol enabled`);
      } else {
        if (result.missing_prerequisites) {
          toast.error('Prerequisites not met', {
            description: result.missing_prerequisites.join(', '),
          });
        } else {
          toast.error('Failed to enable protocol', { description: result.error });
        }
      }
      setLoadingAction(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to enable protocol', { description: error.message });
      setLoadingAction(null);
    },
  });

  // Handle both wrapped and unwrapped data formats
  const templates = Array.isArray(templatesData) ? templatesData : (templatesData?.data || []);
  const protocols = onboardingState?.protocols
    ? (Object.values(onboardingState.protocols) as ProtocolOnboardingState[])
    : [];

  if (isAuthLoading || isLoadingState) {
    return (
      <div className="p-8 max-w-[1400px] mx-auto">
        <div className="animate-pulse space-y-8">
          <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded" />
          <div className="h-32 bg-gray-200 dark:bg-gray-800 rounded-2xl" />
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-gray-200 dark:bg-gray-800 rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <Rocket className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Authentication Required
          </h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Please log in to access the onboarding guide.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            Platform Setup
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Follow these steps to get started with Sly payment protocols
          </p>
        </div>

        {/* Sandbox Mode Toggle */}
        <div className="flex items-center gap-3 bg-gray-100 dark:bg-gray-900 rounded-xl px-4 py-2">
          <FlaskConical className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Sandbox Mode
          </span>
          <button
            onClick={() => sandboxMutation.mutate(!onboardingState?.sandbox_mode)}
            disabled={sandboxMutation.isPending}
            className={cn(
              'relative w-11 h-6 rounded-full transition-colors',
              onboardingState?.sandbox_mode
                ? 'bg-green-500'
                : 'bg-gray-300 dark:bg-gray-700'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform',
                onboardingState?.sandbox_mode ? 'left-5' : 'left-0.5'
              )}
            />
          </button>
        </div>
      </div>

      {/* Overall Progress */}
      <div className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl p-8 mb-8 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold mb-2">Overall Progress</h2>
            <p className="text-blue-100 mb-4">
              {onboardingState?.has_any_protocol_enabled
                ? 'Keep going! Complete the remaining steps to unlock all features.'
                : 'Get started by enabling a protocol and completing the setup steps.'}
            </p>
            <div className="flex items-center gap-4">
              {onboardingState?.has_wallet && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/20 rounded-full text-sm">
                  <CheckCircle className="w-4 h-4" />
                  Wallet Created
                </span>
              )}
              {onboardingState?.has_payment_handler && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/20 rounded-full text-sm">
                  <CheckCircle className="w-4 h-4" />
                  Payment Handler Connected
                </span>
              )}
              {!onboardingState?.has_wallet && !onboardingState?.has_payment_handler && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/20 rounded-full text-sm">
                  <AlertCircle className="w-4 h-4" />
                  No prerequisites completed yet
                </span>
              )}
            </div>
          </div>
          <ProgressRing progress={onboardingState?.overall_progress || 0} />
        </div>
      </div>

      {/* Resume Setup Card - Show when there are in-progress wizards */}
      <ResumeSetupCard />

      {/* Quick Start Templates - Always visible for easy access */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
          Quick Start Templates
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              isRecommended={template.id === onboardingState?.recommended_template?.id}
            />
          ))}
        </div>
      </div>

      {/* Protocol Onboarding */}
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
          Protocol Setup
        </h2>
        <div className="space-y-4">
          {protocols.map((protocolState) => (
            <ProtocolOnboardingCard
              key={protocolState.protocol_id}
              state={protocolState}
              onCompleteStep={(stepId) => {
                setLoadingAction(`${protocolState.protocol_id}-${stepId}-complete`);
                completeStepMutation.mutate({
                  protocolId: protocolState.protocol_id,
                  stepId,
                });
              }}
              onSkipStep={(stepId) => {
                setLoadingAction(`${protocolState.protocol_id}-${stepId}-skip`);
                skipStepMutation.mutate({
                  protocolId: protocolState.protocol_id,
                  stepId,
                });
              }}
              onReset={() => {
                setLoadingAction(`${protocolState.protocol_id}-reset`);
                resetMutation.mutate(protocolState.protocol_id);
              }}
              onEnable={() => {
                setLoadingAction(`${protocolState.protocol_id}-enable`);
                enableProtocolMutation.mutate(protocolState.protocol_id);
              }}
              isLoading={loadingAction?.startsWith(protocolState.protocol_id) && !loadingAction?.endsWith('-enable') || false}
              isEnabling={loadingAction === `${protocolState.protocol_id}-enable`}
            />
          ))}
        </div>
      </div>

      {/* Help Section */}
      <div className="mt-8 bg-gray-50 dark:bg-gray-900/50 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Need help?</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Not sure which protocol to start with? Here's a quick guide:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-yellow-100 dark:bg-yellow-950 flex items-center justify-center flex-shrink-0">
              <Zap className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">
                x402 Micropayments
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                Best for API monetization with pay-per-call pricing
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-950 flex items-center justify-center flex-shrink-0">
              <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">
                AP2 Mandates
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                Best for recurring agent payments with spending limits
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-950 flex items-center justify-center flex-shrink-0">
              <ShoppingCart className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">
                ACP Agent Commerce
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                Best for AI agents making purchases (Stripe/OpenAI compatible)
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-100 dark:bg-green-950 flex items-center justify-center flex-shrink-0">
              <Globe className="w-4 h-4 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">
                UCP Universal Commerce
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                Best for e-commerce with hosted checkout and identity linking
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
