'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { loadStripeOnramp } from '@stripe/crypto';

type StripeOnramp = Awaited<ReturnType<typeof loadStripeOnramp>>;

const CryptoElementsContext = createContext<{ onramp: StripeOnramp | null }>({ onramp: null });

const STRIPE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';

export function CryptoElements({ children }: { children: React.ReactNode }) {
  const [ctx, setCtx] = useState<{ onramp: StripeOnramp | null }>({ onramp: null });

  useEffect(() => {
    let mounted = true;
    if (STRIPE_KEY) {
      loadStripeOnramp(STRIPE_KEY).then((onramp) => {
        if (mounted && onramp) setCtx({ onramp });
      });
    }
    return () => { mounted = false; };
  }, []);

  return (
    <CryptoElementsContext.Provider value={ctx}>
      {children}
    </CryptoElementsContext.Provider>
  );
}

export function useStripeOnramp() {
  return useContext(CryptoElementsContext).onramp;
}

interface OnrampElementProps {
  clientSecret: string;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

export function OnrampElement({ clientSecret, onComplete, onError }: OnrampElementProps) {
  const stripeOnramp = useStripeOnramp();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !clientSecret || !stripeOnramp) return;

    el.innerHTML = '';

    const session = stripeOnramp.createSession({
      clientSecret,
      appearance: { theme: 'light' as any },
    });

    session.addEventListener('onramp_session_updated', (event: any) => {
      const status = event?.payload?.session?.status;
      if (status === 'fulfillment_complete') {
        onComplete?.();
      } else if (status === 'rejected') {
        onError?.('Payment was rejected. Please try again.');
      }
    });

    session.mount(el);

    return () => { el.innerHTML = ''; };
  }, [clientSecret, stripeOnramp, onComplete, onError]);

  return <div ref={containerRef} style={{ minHeight: 400 }} />;
}
