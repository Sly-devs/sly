'use client';

import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Bot,
  Terminal,
  Network,
  Code,
  Globe,
  FileCode,
  Copy,
  Check,
  ExternalLink,
  Download,
} from 'lucide-react';
import { GlowButton } from '../shared/glow-button';
import { Celebration } from '../shared/celebration';
import { toast } from 'sonner';

interface IntegrationStepProps {
  apiKeys: { test: { key: string; prefix: string }; live: { key: string; prefix: string } } | null;
  accountId: string | null;
  onComplete: () => void;
}

interface IntegrationCard {
  id: string;
  icon: typeof Terminal;
  title: string;
  description: string;
  accent: string;
  docsUrl: string;
  logos: string[];
  getContent: (testKey: string, liveKey: string, accountId: string) => string;
}

// Order: Skills, A2A, MCP, CLI, SDK, ChatGPT, REST API
const cards: IntegrationCard[] = [
  {
    id: 'skills',
    icon: FileCode,
    title: 'Skills.md',
    description: 'Discoverable agent skill manifest',
    accent: 'amber',
    docsUrl: 'https://docs.getsly.ai/guides/skills',
    logos: ['Claude', 'ChatGPT', 'Gemini', 'Any Agent'],
    getContent: () => 'https://api.getsly.ai/v1/skills.md',
  },
  {
    id: 'a2a',
    icon: Network,
    title: 'A2A Protocol',
    description: 'Discover Sly\'s platform agent card and capabilities',
    accent: 'indigo',
    docsUrl: 'https://docs.getsly.ai/guides/a2a',
    logos: ['Google', 'Any A2A Agent'],
    getContent: () => 'https://api.getsly.ai/.well-known/agent.json',
  },
  {
    id: 'mcp',
    icon: Terminal,
    title: 'MCP Server',
    description: 'Model Context Protocol integration',
    accent: 'purple',
    docsUrl: 'https://docs.getsly.ai/guides/mcp',
    logos: ['Claude', 'Gemini', 'Cursor', 'Windsurf'],
    getContent: () => 'npx @sly/mcp-server',
  },
  {
    id: 'cli',
    icon: Terminal,
    title: 'CLI',
    description: 'Shell commands for any agent with exec access',
    accent: 'blue',
    docsUrl: 'https://docs.getsly.ai/guides/cli',
    logos: ['ChatGPT', 'Devin', 'Any Agent'],
    getContent: () => 'npm install https://api.getsly.ai/packages/cli.tgz',
  },
  {
    id: 'sdk',
    icon: Code,
    title: 'SDK',
    description: 'TypeScript/Node.js SDK',
    accent: 'blue',
    docsUrl: 'https://docs.getsly.ai/sdk',
    logos: ['Node.js', 'TypeScript'],
    getContent: () => 'npm install https://api.getsly.ai/packages/sdk.tgz',
  },
  {
    id: 'chatgpt',
    icon: Globe,
    title: 'ChatGPT Actions',
    description: 'Create GPT → Configure → Actions → Import URL',
    accent: 'emerald',
    docsUrl: 'https://docs.getsly.ai/guides/chatgpt',
    logos: ['ChatGPT'],
    getContent: () => 'https://api.getsly.ai/v1/openapi.json',
  },
  {
    id: 'api',
    icon: Globe,
    title: 'REST API',
    description: 'Interactive API docs — browse and test endpoints',
    accent: 'emerald',
    docsUrl: 'https://docs.getsly.ai/api',
    logos: ['Postman', 'Python', 'Go', 'Any'],
    getContent: () => 'https://api.getsly.ai/docs',
  },
];

const accentStyles: Record<string, { icon: string; bg: string }> = {
  purple: { icon: 'text-purple-400', bg: 'bg-purple-500/15' },
  indigo: { icon: 'text-indigo-400', bg: 'bg-indigo-500/15' },
  blue: { icon: 'text-blue-400', bg: 'bg-blue-500/15' },
  emerald: { icon: 'text-emerald-400', bg: 'bg-emerald-500/15' },
  amber: { icon: 'text-amber-400', bg: 'bg-amber-500/15' },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] as const } },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function IntegrationStep({ apiKeys, accountId, onComplete }: IntegrationStepProps) {
  const [showCelebration, setShowCelebration] = useState(false);

  const testKey = apiKeys?.test.key || 'pk_test_...';
  const liveKey = apiKeys?.live.key || 'pk_live_...';
  const acctId = accountId || '<account_id>';

  const downloadMcpJson = useCallback(() => {
    const config = JSON.stringify(
      {
        mcpServers: {
          sly: {
            command: 'npx',
            args: ['@sly/mcp-server'],
            env: {
              SLY_API_KEY: testKey,
              SLY_API_KEY_LIVE: liveKey,
            },
          },
        },
      },
      null,
      2,
    );
    const blob = new Blob([config], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '.mcp.json';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded .mcp.json');
  }, [testKey, liveKey]);

  const handleComplete = useCallback(() => {
    setShowCelebration(true);
  }, []);

  const handleCelebrationDone = useCallback(() => {
    setShowCelebration(false);
    onComplete();
  }, [onComplete]);

  return (
    <>
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="w-full mx-auto space-y-6"
      >
        {/* Bot icon with ring-draw animation */}
        <motion.div variants={fadeUp} className="flex justify-center">
          <div className="relative">
            <svg width="64" height="64" viewBox="0 0 64 64" className="absolute inset-0">
              <motion.circle
                cx="32"
                cy="32"
                r="28"
                fill="none"
                stroke="url(#botGradient)"
                strokeWidth="1.5"
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 1.2, ease: 'easeOut' }}
              />
              <defs>
                <linearGradient id="botGradient" x1="0" y1="0" x2="64" y2="64">
                  <stop offset="0%" stopColor="#8b5cf6" />
                  <stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
              </defs>
            </svg>
            <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center">
              <Bot className="h-7 w-7 text-purple-400" />
            </div>
          </div>
        </motion.div>

        {/* Title */}
        <motion.div variants={fadeUp} className="text-center space-y-2">
          <h2 className="text-2xl font-bold text-foreground">Connect Your Agent</h2>
          <p className="text-sm text-muted-foreground">
            Pick a method to connect your AI agent. It will self-register on first use.
          </p>
        </motion.div>

        {/* Integration cards */}
        <motion.div variants={stagger} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {cards.map((card, i) => {
            const Icon = card.icon;
            const colors = accentStyles[card.accent];
            const content = card.getContent(testKey, liveKey, acctId);
            const isMultiline = content.includes('\n');

            return (
              <motion.div
                key={card.id}
                variants={fadeUp}
                className={`bg-card border border-border rounded-xl p-4 ${
                  i === cards.length - 1 && cards.length % 2 === 1 ? 'sm:col-span-2' : ''
                }`}
              >
                {/* Header row: icon + title + docs link */}
                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${colors.bg}`}
                    >
                      <Icon className={`h-4 w-4 ${colors.icon}`} />
                    </div>
                    <div>
                      <div className="font-medium text-sm text-foreground">{card.title}</div>
                      <div className="text-xs text-muted-foreground">{card.description}</div>
                    </div>
                  </div>
                  <a
                    href={card.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-1 text-xs text-primary hover:underline pt-0.5"
                  >
                    View docs
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                {/* Company logos */}
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  {card.logos.map((logo) => (
                    <span
                      key={logo}
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5"
                    >
                      {logo}
                    </span>
                  ))}
                </div>

                {/* Code/content area */}
                <div className="mt-2 flex items-start gap-2">
                  {card.id === 'mcp' ? (
                    <button
                      onClick={downloadMcpJson}
                      className="flex-1 flex items-center justify-center gap-2 bg-muted rounded-lg p-3 text-xs font-medium text-foreground hover:bg-muted/80 transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download .mcp.json
                    </button>
                  ) : (
                    <>
                      <div
                        className={`flex-1 bg-muted rounded-lg p-3 font-mono text-xs text-foreground overflow-x-auto ${
                          isMultiline ? 'whitespace-pre' : ''
                        }`}
                      >
                        {content}
                      </div>
                      <CopyButton text={content} />
                    </>
                  )}
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Go to Dashboard */}
        <motion.div variants={fadeUp}>
          <GlowButton className="w-full" onClick={handleComplete}>
            Go to Dashboard
          </GlowButton>
        </motion.div>
      </motion.div>

      {/* Celebration overlay */}
      {showCelebration && <Celebration onComplete={handleCelebrationDone} />}
    </>
  );
}
