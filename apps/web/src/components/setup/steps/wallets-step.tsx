'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wallet, Globe, Zap, Plus, Link2, Loader2 } from 'lucide-react';
import { Input } from '@sly/ui';
import { toast } from 'sonner';
import { KeyReveal } from '../shared/key-reveal';
import { AnimatedCheck } from '../shared/animated-check';
import { GlowButton } from '../shared/glow-button';

interface WalletsStepProps {
  orgName: string;
  apiCall: (method: string, path: string, body?: any, env?: 'test' | 'live') => Promise<any>;
  ensureAccount: (env: 'test' | 'live') => Promise<string | null>;
  onNext: () => void;
  onSkip: () => void;
}

interface WalletDef {
  id: string;
  name: string;
  env: 'test' | 'live';
  walletType: string;
  blockchain: string;
  fund?: number;
}

interface WalletProgress {
  defId: string;
  name: string;
  status: 'pending' | 'creating' | 'done' | 'error';
  walletAddress?: string;
  balance?: number;
}

function CountUp({ from, to, duration = 800 }: { from: number; to: number; duration?: number }) {
  const [value, setValue] = useState(from);
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    startTimeRef.current = null;

    function animate(timestamp: number) {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      setValue(from + (to - from) * eased);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [from, to, duration]);

  return <>${value.toFixed(2)}</>;
}

const networks = [
  {
    id: 'base',
    icon: Globe,
    label: 'Base',
    desc: 'USDC on Base L2 — production + sandbox wallets',
    accent: 'blue',
    recommended: true,
  },
  {
    id: 'tempo',
    icon: Zap,
    label: 'Tempo',
    desc: 'USDC on Tempo L2 — production + sandbox wallets',
    accent: 'purple',
    recommended: false,
  },
];

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] as const } },
};

export function WalletsStep({ orgName, apiCall, ensureAccount, onNext, onSkip }: WalletsStepProps) {
  const [selections, setSelections] = useState<Set<string>>(new Set(['base']));
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<WalletProgress[]>([]);
  const [externalAddress, setExternalAddress] = useState('');
  const [linkingExternal, setLinkingExternal] = useState(false);

  const toggleSelection = useCallback((id: string) => {
    setSelections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const createWallets = useCallback(async () => {
    if (selections.size === 0) {
      toast.error('Select at least one network');
      return;
    }

    setCreating(true);

    const walletDefs: WalletDef[] = [];
    // Production wallets route to api.getsly.ai, sandbox to sandbox.getsly.ai
    if (selections.has('base')) {
      walletDefs.push({ id: 'base-live', name: `${orgName} Base Wallet`, env: 'live', walletType: 'circle_custodial', blockchain: 'base' });
      walletDefs.push({ id: 'base-sandbox', name: `${orgName} Base Sandbox Wallet`, env: 'test', walletType: 'circle_custodial', blockchain: 'base', fund: 10 });
    }
    if (selections.has('tempo')) {
      walletDefs.push({ id: 'tempo-live', name: `${orgName} Tempo Wallet`, env: 'live', walletType: 'circle_custodial', blockchain: 'tempo' });
      walletDefs.push({ id: 'tempo-sandbox', name: `${orgName} Tempo Sandbox Wallet`, env: 'test', walletType: 'internal', blockchain: 'tempo' });
    }

    // Initialize progress rows
    setProgress(walletDefs.map((d) => ({ defId: d.id, name: d.name, status: 'pending' })));

    for (const def of walletDefs) {
      // Mark as creating
      setProgress((prev) => prev.map((p) => (p.defId === def.id ? { ...p, status: 'creating' } : p)));

      try {
        const acctId = await ensureAccount(def.env);
        if (!acctId) {
          toast.error(`Failed to create account for ${def.name}`);
          setProgress((prev) => prev.map((p) => (p.defId === def.id ? { ...p, status: 'error' } : p)));
          continue;
        }

        const json = await apiCall(
          'POST',
          '/v1/wallets',
          {
            accountId: acctId,
            name: def.name,
            currency: 'USDC',
            walletType: def.walletType,
            blockchain: def.blockchain,
            purpose: def.env === 'live' ? 'Production wallet' : 'Sandbox wallet for testing',
          },
          def.env,
        );

        const w = json.data || json;
        let balance = 0;

        // Auto-fund sandbox wallets
        if (def.fund && w.id) {
          try {
            await apiCall('POST', `/v1/wallets/${w.id}/test-fund`, { amount: def.fund, currency: 'USDC' }, 'test');
            balance = def.fund;
          } catch {
            /* non-fatal */
          }
        }

        setProgress((prev) =>
          prev.map((p) =>
            p.defId === def.id
              ? {
                  ...p,
                  status: 'done',
                  walletAddress: w.walletAddress || w.wallet_address || '',
                  balance,
                }
              : p,
          ),
        );

        toast.success(`${def.name} created`);
      } catch (e: any) {
        toast.error(`${def.name} failed: ${e.message?.substring(0, 60) || 'Unknown error'}`);
        setProgress((prev) => prev.map((p) => (p.defId === def.id ? { ...p, status: 'error' } : p)));
      }
    }

    setCreating(false);
    // Auto-advance after a brief pause to show completion
    setTimeout(() => onNext(), 1200);
  }, [selections, orgName, apiCall, ensureAccount, onNext]);

  const linkExternalWallet = useCallback(async () => {
    if (!externalAddress.trim()) return;
    setLinkingExternal(true);
    try {
      const acctId = await ensureAccount('test');
      if (!acctId) {
        toast.error('Failed to create account');
        setLinkingExternal(false);
        return;
      }
      await apiCall('POST', '/v1/wallets/external', {
        accountId: acctId,
        walletAddress: externalAddress.trim(),
        name: 'External Wallet',
        currency: 'USDC',
      });
      toast.success('External wallet linked');
      setTimeout(() => onNext(), 800);
    } catch (e: any) {
      toast.error(e.message || 'Failed to link wallet');
    }
    setLinkingExternal(false);
  }, [externalAddress, apiCall, ensureAccount, onNext]);

  const totalWallets = selections.size * 2;

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className="w-full max-w-lg mx-auto space-y-6"
    >
      {/* Wallet icon with ring-draw animation */}
      <motion.div variants={fadeUp} className="flex justify-center">
        <div className="relative">
          <svg width="64" height="64" viewBox="0 0 64 64" className="absolute inset-0">
            <motion.circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              stroke="url(#walletGradient)"
              strokeWidth="1.5"
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 1.2, ease: 'easeOut' }}
            />
            <defs>
              <linearGradient id="walletGradient" x1="0" y1="0" x2="64" y2="64">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
          </svg>
          <div className="w-16 h-16 rounded-full bg-blue-500/10 flex items-center justify-center">
            <Wallet className="h-7 w-7 text-blue-400" />
          </div>
        </div>
      </motion.div>

      {/* Title */}
      <motion.div variants={fadeUp} className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-white">Create Wallets</h2>
        <p className="text-sm text-white/50">
          Select networks to create production + sandbox wallet pairs.
        </p>
      </motion.div>

      {/* Network cards */}
      {!creating && progress.length === 0 && (
        <>
          <motion.div variants={fadeUp} className="space-y-3">
            {networks.map((net) => {
              const Icon = net.icon;
              const isSelected = selections.has(net.id);
              const accentBorder = isSelected
                ? net.accent === 'blue'
                  ? 'border-blue-500/50 bg-blue-500/[0.05]'
                  : 'border-purple-500/50 bg-purple-500/[0.05]'
                : 'bg-white/[0.03] border-white/[0.06] hover:border-white/[0.12]';

              return (
                <motion.button
                  key={net.id}
                  onClick={() => toggleSelection(net.id)}
                  className={`w-full flex items-center gap-4 border rounded-2xl p-4 text-left transition-colors ${accentBorder}`}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 1.02 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                >
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      net.accent === 'blue' ? 'bg-blue-500/15' : 'bg-purple-500/15'
                    }`}
                  >
                    <Icon
                      className={`h-5 w-5 ${
                        net.accent === 'blue' ? 'text-blue-400' : 'text-purple-400'
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-white">{net.label}</span>
                      {net.recommended && (
                        <span className="relative text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                          <span className="absolute inset-0 rounded-full animate-pulse bg-emerald-500/10" />
                          <span className="relative">Recommended</span>
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-white/40 mt-0.5">{net.desc}</p>
                  </div>
                  {/* Selection indicator */}
                  <div
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                      isSelected
                        ? net.accent === 'blue'
                          ? 'border-blue-500 bg-blue-500'
                          : 'border-purple-500 bg-purple-500'
                        : 'border-white/20'
                    }`}
                  >
                    {isSelected && (
                      <motion.svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      >
                        <path
                          d="M5 13l4 4L19 7"
                          stroke="white"
                          strokeWidth={3}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </motion.svg>
                    )}
                  </div>
                </motion.button>
              );
            })}
          </motion.div>

          {/* Create button */}
          <motion.div variants={fadeUp}>
            <GlowButton
              className="w-full"
              disabled={selections.size === 0}
              onClick={createWallets}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create {totalWallets} Wallets
            </GlowButton>
          </motion.div>

          {/* External wallet section */}
          <motion.div
            variants={fadeUp}
            className="bg-white/[0.03] border border-white/[0.06] backdrop-blur-sm rounded-2xl p-4 space-y-3"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-white/60">
              <Link2 className="h-4 w-4" />
              Or link an existing wallet
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="0x... or base58 address"
                value={externalAddress}
                onChange={(e) => setExternalAddress(e.target.value)}
                className="text-sm bg-white/[0.03] border-white/[0.08]"
              />
              <GlowButton
                variant="secondary"
                disabled={!externalAddress.trim() || linkingExternal}
                loading={linkingExternal}
                onClick={linkExternalWallet}
              >
                Link
              </GlowButton>
            </div>
          </motion.div>

          {/* Skip link */}
          <motion.div variants={fadeUp}>
            <button
              onClick={onSkip}
              className="w-full text-center text-sm text-white/30 hover:text-white/60 transition-colors py-2"
            >
              I&apos;ll connect wallets later &rarr;
            </button>
          </motion.div>
        </>
      )}

      {/* Progress rows during/after creation */}
      <AnimatePresence>
        {progress.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-3"
          >
            {progress.map((p, i) => (
              <motion.div
                key={p.defId}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1 }}
                className="bg-white/[0.05] border border-white/10 backdrop-blur-sm rounded-xl p-4"
              >
                <div className="flex items-center gap-3">
                  {/* Status indicator */}
                  <div className="w-6 h-6 flex items-center justify-center shrink-0">
                    {p.status === 'pending' && (
                      <div className="w-2 h-2 rounded-full bg-white/20" />
                    )}
                    {p.status === 'creating' && (
                      <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                    )}
                    {p.status === 'done' && (
                      <AnimatedCheck size={18} className="text-emerald-400" />
                    )}
                    {p.status === 'error' && (
                      <div className="w-2 h-2 rounded-full bg-red-400" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">{p.name}</div>
                    {p.status === 'done' && p.walletAddress && (
                      <div className="mt-1">
                        <KeyReveal
                          text={p.walletAddress}
                          delay={200}
                          speed={20}
                          className="text-xs"
                        />
                      </div>
                    )}
                  </div>

                  {/* Balance with CountUp for sandbox wallets */}
                  {p.status === 'done' && p.balance !== undefined && p.balance > 0 && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-sm font-mono text-emerald-400"
                    >
                      <CountUp from={0} to={p.balance} />
                      {' USDC'}
                    </motion.div>
                  )}
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
