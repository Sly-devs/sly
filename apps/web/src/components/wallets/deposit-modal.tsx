'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  CheckCircle,
  AlertTriangle,
  X,
  Wallet,
  ExternalLink,
} from 'lucide-react';
import { initOnRamp, type CBPayInstanceType } from '@coinbase/cbpay-js';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { toast } from 'sonner';
import { CryptoElements, OnrampElement } from '@/components/providers/stripe-crypto-provider';

const CDP_PROJECT_ID = process.env.NEXT_PUBLIC_CDP_PROJECT_ID || '';

interface DepositModalProps {
  walletId: string;
  walletName?: string;
  walletAddress?: string;
  blockchain?: string;
  walletType?: string;
  onClose: () => void;
}

const BLOCKCHAIN_TO_COINBASE: Record<string, string> = {
  base: 'base',
  eth: 'ethereum',
  ethereum: 'ethereum',
  polygon: 'polygon',
  sol: 'solana',
  solana: 'solana',
};

type Provider = 'coinbase' | 'stripe';
type Phase = 'select-provider' | 'coinbase-init' | 'coinbase-ready' | 'stripe-loading' | 'stripe-embedded' | 'success' | 'error';

export function DepositModal({
  walletId,
  walletName,
  walletAddress,
  blockchain,
  walletType,
  onClose,
}: DepositModalProps) {
  const [phase, setPhase] = useState<Phase>('select-provider');
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stripeClientSecret, setStripeClientSecret] = useState<string | null>(null);

  // Coinbase refs
  const instanceRef = useRef<CBPayInstanceType | null>(null);
  const lastEventAmountRef = useRef<number | null>(null);
  const popupOpenedRef = useRef(false);
  const phaseRef = useRef<Phase>('select-provider');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const api = useApiClient();
  const { authToken, apiUrl } = useApiConfig();
  const authTokenRef = useRef(authToken);
  const apiUrlRef = useRef(apiUrl);
  useEffect(() => { authTokenRef.current = authToken; }, [authToken]);
  useEffect(() => { apiUrlRef.current = apiUrl; }, [apiUrl]);
  const queryClient = useQueryClient();

  const isOnChain = walletAddress && !walletAddress.startsWith('internal://');

  // Shared completion handler
  const handleDepositComplete = useCallback(async () => {
    if (phaseRef.current === 'success') return;
    setPhase('success');
    toast.success('Deposit completed! Syncing wallet...');

    const token = authTokenRef.current;
    const url = apiUrlRef.current;
    if (!token) return;

    // In sandbox: use Circle faucet for real testnet USDC
    if (process.env.NODE_ENV === 'development') {
      try {
        const resp = await fetch(`${url}/v1/wallets/${walletId}/fund`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ currency: 'USDC', native: true }),
        });
        if (!resp.ok) {
          await fetch(`${url}/v1/wallets/${walletId}/test-fund`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: lastEventAmountRef.current || 100, currency: 'USDC' }),
          });
        }
      } catch {}
    }

    // Sync wallet balance
    const syncWallet = async () => {
      try {
        await fetch(`${url}/v1/wallets/${walletId}/sync`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
      } catch {}
      queryClient.invalidateQueries({ queryKey: ['wallet', walletId] });
      queryClient.invalidateQueries({ queryKey: ['wallet-balance', walletId] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    };
    syncWallet();
    setTimeout(syncWallet, 10000);
  }, [walletId, queryClient]);

  // ── Coinbase flow ──
  const initCoinbase = useCallback(async () => {
    if (!api || !walletAddress) return;
    setPhase('coinbase-init');

    try {
      const session = await api.fundingSources.createOnrampSession({ walletId });
      const network = session.network || BLOCKCHAIN_TO_COINBASE[blockchain || 'base'] || 'base';
      const isSandbox = process.env.NODE_ENV === 'development';

      initOnRamp(
        {
          appId: CDP_PROJECT_ID,
          ...(isSandbox ? { host: 'https://pay-sandbox.coinbase.com' } : {}),
          widgetParameters: {
            addresses: { [walletAddress]: [network] },
            assets: ['USDC'],
            defaultAsset: 'USDC',
            defaultNetwork: network,
            sessionToken: session.session_token,
          } as any,
          onSuccess: () => handleDepositComplete(),
          onExit: () => {
            if (process.env.NODE_ENV === 'development') handleDepositComplete();
          },
          onEvent: (event: any) => {
            const amount = event?.purchaseAmount || event?.amount || event?.cryptoAmount;
            if (amount && !isNaN(Number(amount))) lastEventAmountRef.current = Number(amount);
          },
          experienceLoggedIn: 'popup',
          experienceLoggedOut: 'popup',
          closeOnExit: true,
          closeOnSuccess: true,
        },
        (err, instance) => {
          if (err) {
            setError(typeof err === 'string' ? err : (err as Error).message);
            setPhase('error');
          } else if (instance) {
            instanceRef.current = instance;
            setPhase('coinbase-ready');
          }
        }
      );
    } catch (err: any) {
      setError(err.message || 'Failed to initialize Coinbase');
      setPhase('error');
    }
  }, [api, walletAddress, walletId, blockchain, handleDepositComplete]);

  // Coinbase focus fallback
  useEffect(() => {
    const handleFocus = () => {
      if (popupOpenedRef.current && phaseRef.current === 'coinbase-ready') {
        setTimeout(() => {
          if (phaseRef.current === 'coinbase-ready') handleDepositComplete();
        }, 2000);
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [handleDepositComplete]);

  const handleCoinbaseBuy = useCallback(() => {
    popupOpenedRef.current = true;
    instanceRef.current?.open();
  }, []);

  // ── Stripe flow ──
  const initStripe = useCallback(async () => {
    if (!api) return;
    setPhase('stripe-loading');

    try {
      const session = await api.fundingSources.createStripeOnrampSession({ walletId });
      setStripeClientSecret(session.client_secret);
      setPhase('stripe-embedded');
    } catch (err: any) {
      setError(err.message || 'Failed to initialize Stripe');
      setPhase('error');
    }
  }, [api, walletId]);

  // ── Provider selection ──
  const selectProvider = useCallback((provider: Provider) => {
    setSelectedProvider(provider);
    if (provider === 'coinbase') initCoinbase();
    else initStripe();
  }, [initCoinbase, initStripe]);

  const handleClose = useCallback(() => {
    instanceRef.current?.destroy();
    onClose();
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {phase === 'success' ? 'Deposit Complete' : 'Deposit USDC'}
            </h2>
            {walletName && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">to {walletName}</p>
            )}
          </div>
          <button onClick={handleClose} className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {/* No on-chain address */}
          {!isOnChain && (
            <div className="text-center py-6">
              <div className="w-14 h-14 bg-yellow-100 dark:bg-yellow-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                <Wallet className="w-7 h-7 text-yellow-600 dark:text-yellow-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">On-Chain Wallet Required</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
                This wallet doesn't have an on-chain address. To deposit real USDC, create a Circle wallet.
              </p>
              <button onClick={handleClose} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors">Got It</button>
            </div>
          )}

          {/* ── Provider Selection ── */}
          {phase === 'select-provider' && isOnChain && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">Choose how you'd like to buy USDC:</p>

              {/* Coinbase option */}
              <button
                onClick={() => selectProvider('coinbase')}
                className="w-full p-4 rounded-xl border-2 border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-500 transition-colors text-left"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-gray-900 dark:text-white">Coinbase</span>
                  <span className="text-sm font-bold text-green-600 dark:text-green-400">0% fee</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Card, bank transfer, Apple Pay. Opens in a popup window.
                </p>
              </button>

              {/* Stripe option */}
              <button
                onClick={() => selectProvider('stripe')}
                className="w-full p-4 rounded-xl border-2 border-gray-200 dark:border-gray-700 hover:border-purple-500 dark:hover:border-purple-500 transition-colors text-left"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-gray-900 dark:text-white">Stripe</span>
                  <span className="text-sm font-medium text-gray-500 dark:text-gray-400">1.5% fee</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Card, bank transfer, Apple Pay, Google Pay. Embedded checkout — no popup.
                </p>
              </button>

              <p className="text-center text-xs text-gray-400 dark:text-gray-500">
                Both deliver USDC directly to your wallet. Sly never holds your money.
              </p>
            </div>
          )}

          {/* ── Coinbase Loading ── */}
          {phase === 'coinbase-init' && (
            <div className="text-center py-12">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-4" />
              <p className="text-gray-500 dark:text-gray-400">Initializing Coinbase...</p>
            </div>
          )}

          {/* ── Coinbase Ready ── */}
          {phase === 'coinbase-ready' && (
            <div className="space-y-5">
              <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">Destination</span>
                  <span className="font-mono text-xs text-gray-700 dark:text-gray-300 truncate max-w-[200px]">{walletAddress}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">Network</span>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 capitalize">{blockchain || 'base'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">Asset</span>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">USDC</span>
                </div>
              </div>

              <button onClick={handleCoinbaseBuy} className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors">
                <ExternalLink className="w-5 h-5" />
                Buy USDC with Coinbase
              </button>

              <p className="text-center text-xs text-gray-400">0% fees on USDC. Powered by Coinbase.</p>
            </div>
          )}

          {/* ── Stripe Loading ── */}
          {phase === 'stripe-loading' && (
            <div className="text-center py-12">
              <Loader2 className="w-8 h-8 text-purple-600 animate-spin mx-auto mb-4" />
              <p className="text-gray-500 dark:text-gray-400">Loading Stripe checkout...</p>
            </div>
          )}

          {/* ── Stripe Embedded ── */}
          {phase === 'stripe-embedded' && stripeClientSecret && (
            <CryptoElements>
              <OnrampElement
                clientSecret={stripeClientSecret}
                onComplete={handleDepositComplete}
                onError={(msg) => { setError(msg); setPhase('error'); }}
              />
            </CryptoElements>
          )}

          {/* ── Error ── */}
          {phase === 'error' && isOnChain && (
            <div className="text-center py-6">
              <div className="w-14 h-14 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-7 h-7 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Something went wrong</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{error || 'Failed to load payment.'}</p>
              <div className="flex gap-3 justify-center">
                <button onClick={() => { setError(null); setPhase('select-provider'); }} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors">Try Again</button>
                <button onClick={handleClose} className="px-6 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium rounded-lg transition-colors">Close</button>
              </div>
            </div>
          )}

          {/* ── Success ── */}
          {phase === 'success' && isOnChain && (
            <div className="text-center py-6">
              <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white">Deposit Successful!</h3>
              <p className="text-gray-600 dark:text-gray-400 mt-2 mb-6">USDC has been delivered to your wallet. It may take a few minutes to appear.</p>
              <button onClick={handleClose} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors">Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
