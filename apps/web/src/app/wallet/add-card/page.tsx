/**
 * Hosted card-add page (Epic 88, Phase 1).
 *
 * Mounts Stripe's Payment Element on a SetupIntent client_secret. On submit,
 * confirmSetup() attaches the PaymentMethod to the user's Stripe Customer.
 * The wallet_payment_methods row is created server-side by the
 * setup_intent.succeeded webhook.
 *
 * Test card: 4242 4242 4242 4242 — any future expiry, any CVC, any ZIP.
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import { Loader2, ShieldCheck, CreditCard, ArrowLeft } from 'lucide-react';

interface SetupIntentResp {
  client_secret: string;
  setup_intent_id: string;
  stripe_customer_id: string;
  publishable_key: string;
}

// Bare props plumb the SetupIntent id + apiFetch into the inner form so
// it can synchronously vault the card after confirmSetup succeeds.

export default function AddCardPage() {
  const router = useRouter();
  const { authToken, apiUrl, isLoading: authLoading } = useApiConfig();
  const apiFetch = useApiFetch();
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!authToken) {
      setError('Sign in to the Sly dashboard before adding a card.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`${apiUrl}/v1/wallet/setup-intent`, { method: 'POST' });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `Could not start card-add session (${res.status})`);
        }
        const json = await res.json();
        const data: SetupIntentResp = json.data;
        if (cancelled) return;
        if (!data?.publishable_key) {
          throw new Error('Stripe publishable key not configured on the API.');
        }
        setStripePromise(loadStripe(data.publishable_key));
        setClientSecret(data.client_secret);
        setSetupIntentId(data.setup_intent_id);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Network error');
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, authToken, apiFetch, apiUrl]);

  return (
    <Shell>
      <button
        type="button"
        onClick={() => router.push('/dashboard/wallet')}
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to wallet
      </button>

      <div className="mb-6">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
          <CreditCard className="h-5 w-5" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Add a payment method
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Your card stays with Stripe — Sly never sees the number. Used by your agents to check out.
        </p>
      </div>

      {error && (
        <Card>
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        </Card>
      )}

      {!error && (!stripePromise || !clientSecret) && (
        <Card>
          <div className="flex items-center justify-center gap-2 py-6 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading secure form…
          </div>
        </Card>
      )}

      {stripePromise && clientSecret && setupIntentId && (
        <Elements
          stripe={stripePromise}
          options={{
            clientSecret,
            appearance: {
              theme: 'flat',
              variables: {
                fontFamily: 'system-ui, -apple-system, sans-serif',
                colorPrimary: '#0f172a',
                borderRadius: '12px',
              },
            },
          }}
        >
          <CardForm setupIntentId={setupIntentId} />
        </Elements>
      )}

      <p className="mt-4 flex items-center justify-center gap-1 text-xs text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5" />
        Secured by Stripe — PCI-compliant
      </p>
      <p className="mt-2 text-center text-[11px] text-slate-400">
        Test card: 4242 4242 4242 4242 · any future date · any CVC
      </p>
    </Shell>
  );
}

function CardForm({ setupIntentId }: { setupIntentId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const apiFetch = useApiFetch();
  const { apiUrl } = useApiConfig();
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setErrMsg(null);
    const { error: submitError } = await elements.submit();
    if (submitError) {
      setErrMsg(submitError.message || 'Could not submit card.');
      setSubmitting(false);
      return;
    }
    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/dashboard/wallet?added=1`,
      },
      // No redirect: Stripe will only redirect for 3DS challenges or wallet
      // flows that require it. For 4242 in test mode the call returns
      // synchronously with status='succeeded' — we surface that inline.
      redirect: 'if_required',
    });
    if (error) {
      setErrMsg(error.message || 'Could not save card.');
      setSubmitting(false);
      return;
    }
    // Synchronously vault the row (don't depend on Stripe webhook
    // tunneling for the demo).
    try {
      const r = await apiFetch(`${apiUrl}/v1/wallet/payment-methods/finalize`, {
        method: 'POST',
        body: JSON.stringify({ setup_intent_id: setupIntentId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErrMsg(j.error || `Vault failed (${r.status})`);
        setSubmitting(false);
        return;
      }
    } catch (e: any) {
      setErrMsg(e?.message ?? 'Network error vaulting card.');
      setSubmitting(false);
      return;
    }
    setDone(true);
    setTimeout(() => router.push('/dashboard/wallet?added=1'), 800);
  }

  if (done) {
    return (
      <Card accent="emerald">
        <div className="flex items-center gap-3 py-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
            <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Card saved · taking you back to your wallet…
          </div>
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <PaymentElement options={{ layout: 'tabs' }} />
      </Card>
      {errMsg && (
        <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{errMsg}</p>
      )}
      <button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-slate-800 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Saving card…
          </>
        ) : (
          <>Save card</>
        )}
      </button>
    </form>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 dark:bg-slate-950 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-md">{children}</div>
    </div>
  );
}

function Card({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: 'emerald';
}) {
  const accentClass = accent === 'emerald'
    ? 'border-emerald-200 dark:border-emerald-900'
    : 'border-slate-200 dark:border-slate-800';
  return (
    <div className={`rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-900 ${accentClass}`}>
      {children}
    </div>
  );
}
