'use client';

import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Shield, Copy, Check, AlertCircle, Download, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { KeyReveal } from '../shared/key-reveal';
import { GlowButton } from '../shared/glow-button';

interface ApiKeysStepProps {
  apiKeys: { test: { key: string; prefix: string }; live: { key: string; prefix: string } };
  orgName: string;
  onNext: () => void;
}

function downloadKeysAsEnv(testKey: string, liveKey: string, orgName: string) {
  const content = [
    `# ${orgName} — Sly API Keys`,
    `# Generated: ${new Date().toISOString()}`,
    `# Docs: https://docs.getsly.ai`,
    '',
    '# Sandbox (test mode)',
    `SLY_API_KEY=${testKey}`,
    '',
    '# Production (live mode)',
    `SLY_API_KEY_LIVE=${liveKey}`,
    '',
    '# API endpoint',
    'SLY_API_URL=https://api.getsly.ai',
    '',
  ].join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sly-api-keys.env';
  a.click();
  URL.revokeObjectURL(url);
}

const stagger = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08 },
  },
};

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] as const } },
};

export function ApiKeysStep({ apiKeys, orgName, onNext }: ApiKeysStepProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = useCallback(async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(label);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  const keys = [
    { label: 'Sandbox (Test)', key: apiKeys.test.key, id: 'test', delay: 200 },
    { label: 'Production (Live)', key: apiKeys.live.key, id: 'live', delay: 400 },
  ];

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className="w-full max-w-lg mx-auto space-y-6"
    >
      {/* Shield icon with ring-draw animation */}
      <motion.div variants={fadeUp} className="flex justify-center">
        <div className="relative">
          <svg width="64" height="64" viewBox="0 0 64 64" className="absolute inset-0">
            <motion.circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              stroke="url(#shieldGradient)"
              strokeWidth="1.5"
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 1.2, ease: 'easeOut' }}
            />
            <defs>
              <linearGradient id="shieldGradient" x1="0" y1="0" x2="64" y2="64">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#10b981" />
              </linearGradient>
            </defs>
          </svg>
          <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
            <Shield className="h-7 w-7 text-emerald-400" />
          </div>
        </div>
      </motion.div>

      {/* Title + subtitle */}
      <motion.div variants={fadeUp} className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-foreground">Your API Keys</h2>
        <p className="text-sm text-muted-foreground">
          Save these keys — they won&apos;t be shown again.
        </p>
      </motion.div>

      {/* Warning banner */}
      <motion.div
        variants={fadeUp}
        className="flex items-center gap-2.5 rounded-xl border border-amber-300 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-800 dark:text-amber-200/90"
      >
        <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
        These API keys are shown only once. Download or copy them now.
      </motion.div>

      {/* Key cards */}
      {keys.map(({ label, key, id, delay }) => (
        <motion.div
          key={id}
          variants={fadeUp}
          className="bg-muted border border-border backdrop-blur-sm rounded-xl p-4 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {label}
            </span>
            <button
              onClick={() => handleCopy(key, id)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
            >
              {copiedKey === id ? (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="inline-flex items-center gap-1 text-emerald-400"
                >
                  <Check className="h-3.5 w-3.5" />
                  Copied
                </motion.span>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </button>
          </div>
          <div className="font-mono text-sm">
            <KeyReveal text={key} delay={delay} speed={25} />
          </div>
        </motion.div>
      ))}

      {/* Bottom buttons */}
      <motion.div variants={fadeUp} className="flex gap-3 pt-2">
        <GlowButton
          variant="secondary"
          className="flex-1"
          onClick={() => downloadKeysAsEnv(apiKeys.test.key, apiKeys.live.key, orgName)}
        >
          <Download className="h-4 w-4 mr-2" />
          Download .env
        </GlowButton>
        <GlowButton className="flex-1" onClick={onNext}>
          Next
          <ArrowRight className="h-4 w-4 ml-2" />
        </GlowButton>
      </motion.div>
    </motion.div>
  );
}
