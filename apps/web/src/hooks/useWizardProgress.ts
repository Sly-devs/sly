'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import {
  type TemplateId,
  type WizardProgress,
  type WizardState,
  WIZARD_TEMPLATES,
  LEGACY_TEMPLATE_MAP,
} from '@/types/wizard';

const STORAGE_KEY = 'payos_wizard_progress';

// Get all wizard progress from localStorage
function getStoredProgress(): Partial<Record<TemplateId, WizardProgress>> {
  if (typeof window === 'undefined') return {};

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

// Save wizard progress to localStorage
function saveStoredProgress(progress: Partial<Record<TemplateId, WizardProgress>>): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {
    console.error('Failed to save wizard progress:', e);
  }
}

// Get progress for a specific template
function getTemplateProgress(templateId: TemplateId): WizardProgress | null {
  const allProgress = getStoredProgress();
  return allProgress[templateId] || null;
}

// Save progress for a specific template
function saveTemplateProgress(templateId: TemplateId, progress: WizardProgress): void {
  const allProgress = getStoredProgress();
  allProgress[templateId] = progress;
  saveStoredProgress(allProgress);
}

// Get all incomplete wizard sessions for dashboard display
export function getIncompleteWizards(): WizardProgress[] {
  const allProgress = getStoredProgress();
  return Object.values(allProgress).filter(p => !p.isComplete);
}

// Check if a template has in-progress wizard
export function hasInProgressWizard(templateId: TemplateId | string): boolean {
  const normalizedId = LEGACY_TEMPLATE_MAP[templateId] || templateId as TemplateId;
  const progress = getTemplateProgress(normalizedId);
  return progress !== null && !progress.isComplete;
}

// Get progress percentage for a template
export function getWizardProgressPercent(templateId: TemplateId | string): number {
  const normalizedId = LEGACY_TEMPLATE_MAP[templateId] || templateId as TemplateId;
  const progress = getTemplateProgress(normalizedId);
  if (!progress) return 0;

  const template = WIZARD_TEMPLATES[normalizedId];
  if (!template) return 0;

  const completedCount = progress.completedSteps.length + progress.skippedSteps.length;
  return Math.round((completedCount / template.steps.length) * 100);
}

interface UseWizardProgressOptions {
  templateId: TemplateId | string;
  autoSave?: boolean;
}

interface UseWizardProgressReturn extends WizardState {
  // Navigation
  goToStep: (stepIndex: number) => void;
  nextStep: () => void;
  previousStep: () => void;

  // Step actions
  completeStep: (data?: unknown) => void;
  skipStep: () => void;

  // Overall
  resetProgress: () => void;
  completeWizard: () => void;

  // Computed
  progressPercent: number;
  estimatedTimeRemaining: string;
  canSkipCurrentStep: boolean;
  isCurrentStepComplete: boolean;

  // Meta
  templateConfig: typeof WIZARD_TEMPLATES[TemplateId];
}

export function useWizardProgress({
  templateId: rawTemplateId,
  autoSave = true,
}: UseWizardProgressOptions): UseWizardProgressReturn {
  const router = useRouter();
  const { authToken, apiUrl } = useApiConfig();

  // Normalize template ID
  const templateId = (LEGACY_TEMPLATE_MAP[rawTemplateId] || rawTemplateId) as TemplateId;
  const templateConfig = WIZARD_TEMPLATES[templateId];

  // State
  const [state, setState] = useState<WizardState>(() => {
    const stored = getTemplateProgress(templateId);
    return {
      templateId,
      templateName: templateConfig?.name || 'Unknown Template',
      currentStep: stored?.currentStep || 0,
      totalSteps: templateConfig?.steps.length || 0,
      steps: templateConfig?.steps || [],
      completedSteps: new Set(stored?.completedSteps || []),
      skippedSteps: new Set(stored?.skippedSteps || []),
      stepData: stored?.stepData || {},
      isLoading: false,
      error: null,
    };
  });

  // Persist to localStorage whenever state changes
  useEffect(() => {
    if (!autoSave || !templateConfig) return;

    const progress: WizardProgress = {
      templateId,
      currentStep: state.currentStep,
      completedSteps: Array.from(state.completedSteps),
      skippedSteps: Array.from(state.skippedSteps),
      stepData: state.stepData,
      startedAt: getTemplateProgress(templateId)?.startedAt || new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      isComplete: state.currentStep >= state.totalSteps &&
        (state.completedSteps.size + state.skippedSteps.size) >= state.totalSteps,
    };

    saveTemplateProgress(templateId, progress);
  }, [autoSave, templateId, templateConfig, state]);

  // Sync with backend (optional, for cross-device support)
  const syncWithBackend = useCallback(async () => {
    if (!authToken) return;

    try {
      const response = await fetch(`${apiUrl}/v1/onboarding/wizard/${templateId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          currentStep: state.currentStep,
          completedSteps: Array.from(state.completedSteps),
          skippedSteps: Array.from(state.skippedSteps),
          stepData: state.stepData,
        }),
      });

      if (!response.ok) {
        console.warn('Failed to sync wizard progress with backend');
      }
    } catch (e) {
      console.warn('Failed to sync wizard progress:', e);
    }
  }, [authToken, apiUrl, templateId, state]);

  // Navigation
  const goToStep = useCallback((stepIndex: number) => {
    if (stepIndex < 0 || stepIndex >= state.totalSteps) return;
    setState(prev => ({ ...prev, currentStep: stepIndex }));
  }, [state.totalSteps]);

  const nextStep = useCallback(() => {
    if (state.currentStep < state.totalSteps - 1) {
      setState(prev => ({ ...prev, currentStep: prev.currentStep + 1 }));
    }
  }, [state.currentStep, state.totalSteps]);

  const previousStep = useCallback(() => {
    if (state.currentStep > 0) {
      setState(prev => ({ ...prev, currentStep: prev.currentStep - 1 }));
    }
  }, [state.currentStep]);

  // Step actions
  const completeStep = useCallback((data?: unknown) => {
    const currentStepDef = state.steps[state.currentStep];
    if (!currentStepDef) return;

    setState(prev => {
      const newCompletedSteps = new Set(prev.completedSteps);
      newCompletedSteps.add(currentStepDef.id);

      // Remove from skipped if it was previously skipped
      const newSkippedSteps = new Set(prev.skippedSteps);
      newSkippedSteps.delete(currentStepDef.id);

      const newStepData = data !== undefined
        ? { ...prev.stepData, [currentStepDef.id]: data }
        : prev.stepData;

      const newCurrentStep = prev.currentStep < prev.totalSteps - 1
        ? prev.currentStep + 1
        : prev.currentStep;

      return {
        ...prev,
        completedSteps: newCompletedSteps,
        skippedSteps: newSkippedSteps,
        stepData: newStepData,
        currentStep: newCurrentStep,
      };
    });

    toast.success('Step completed');
    syncWithBackend();
  }, [state.steps, state.currentStep, syncWithBackend]);

  const skipStep = useCallback(() => {
    const currentStepDef = state.steps[state.currentStep];
    if (!currentStepDef || currentStepDef.isRequired) return;

    setState(prev => {
      const newSkippedSteps = new Set(prev.skippedSteps);
      newSkippedSteps.add(currentStepDef.id);

      const newCurrentStep = prev.currentStep < prev.totalSteps - 1
        ? prev.currentStep + 1
        : prev.currentStep;

      return {
        ...prev,
        skippedSteps: newSkippedSteps,
        currentStep: newCurrentStep,
      };
    });

    toast.info('Step skipped');
    syncWithBackend();
  }, [state.steps, state.currentStep, syncWithBackend]);

  // Overall actions
  const resetProgress = useCallback(() => {
    setState(prev => ({
      ...prev,
      currentStep: 0,
      completedSteps: new Set(),
      skippedSteps: new Set(),
      stepData: {},
    }));

    // Clear from localStorage
    const allProgress = getStoredProgress();
    delete allProgress[templateId];
    saveStoredProgress(allProgress);

    toast.success('Progress reset');
  }, [templateId]);

  const completeWizard = useCallback(() => {
    const progress = getTemplateProgress(templateId);
    if (progress) {
      progress.isComplete = true;
      saveTemplateProgress(templateId, progress);
    }

    toast.success(`${templateConfig?.name || 'Setup'} complete!`);
    router.push('/dashboard/onboarding');
  }, [templateId, templateConfig, router]);

  // Computed values
  const progressPercent = useMemo(() => {
    if (state.totalSteps === 0) return 0;
    const completed = state.completedSteps.size + state.skippedSteps.size;
    return Math.round((completed / state.totalSteps) * 100);
  }, [state.completedSteps, state.skippedSteps, state.totalSteps]);

  const estimatedTimeRemaining = useMemo(() => {
    const remainingSteps = state.steps.filter(
      (step, idx) =>
        idx >= state.currentStep &&
        !state.completedSteps.has(step.id) &&
        !state.skippedSteps.has(step.id)
    );

    const totalMinutes = remainingSteps.reduce(
      (sum, step) => sum + (step.estimatedMinutes || 2),
      0
    );

    if (totalMinutes === 0) return 'Complete';
    if (totalMinutes < 1) return '< 1 min';
    return `~${totalMinutes} min`;
  }, [state.steps, state.currentStep, state.completedSteps, state.skippedSteps]);

  const currentStepDef = state.steps[state.currentStep];
  const canSkipCurrentStep = currentStepDef ? !currentStepDef.isRequired : false;
  const isCurrentStepComplete = currentStepDef
    ? state.completedSteps.has(currentStepDef.id) || state.skippedSteps.has(currentStepDef.id)
    : false;

  return {
    ...state,
    templateConfig,

    // Navigation
    goToStep,
    nextStep,
    previousStep,

    // Step actions
    completeStep,
    skipStep,

    // Overall
    resetProgress,
    completeWizard,

    // Computed
    progressPercent,
    estimatedTimeRemaining,
    canSkipCurrentStep,
    isCurrentStepComplete,
  };
}

// Hook for dashboard to get all wizard progress
export function useAllWizardProgress() {
  const [wizards, setWizards] = useState<WizardProgress[]>([]);

  useEffect(() => {
    setWizards(getIncompleteWizards());
  }, []);

  const refresh = useCallback(() => {
    setWizards(getIncompleteWizards());
  }, []);

  return { wizards, refresh };
}
