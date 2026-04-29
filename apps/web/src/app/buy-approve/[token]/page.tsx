/**
 * Guest checkout page (Epic 88, B2C).
 *
 * Public — no Sly account required. The magic token in the URL IS the
 * authorization. Loads cart + agent context from /v1/buy-approve/:token/info,
 * mounts Stripe Payment Element on a fresh PaymentIntent's client_secret,
 * lets the user enter a card, and on success calls /v1/buy-approve/:token/finalize.
 *
 * The same page handles "already executed" by rendering the receipt — so
 * a user who taps the link a second time sees what happened, not a card form.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { use as usePromise } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { Bot, Check, Clock, Loader2, MapPin, ShieldAlert, Sparkles, ShieldCheck, ExternalLink } from 'lucide-react';

interface CartItem { name: string; quantity: number; total?: number; price?: number }
interface InfoAwaiting {
  status: 'awaiting_payment';
  merchant: string;
  total: number;
  currency: string;
  items: CartItem[];
  agent: string;
  reason: string | null;
  publishable_key: string;
  payment_intent_client_secret: string;
}
interface InfoExecuted {
  status: 'executed';
  merchant: string;
  total: number;
  currency: string;
  items: CartItem[];
  agent: string;
  receipt: { stripe_payment_intent_id: string | null; card_brand: string | null; card_last4: string | null };
}
type Info = InfoAwaiting | InfoExecuted | { status: 'rejected' | 'expired' } | { status: 'error'; error: string };

export default function GuestCheckoutPage(props: { params: Promise<{ token: string }> }) {
  const { token } = usePromise(props.params);
  const [info, setInfo] = useState<Info | null>(null);
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);

  // Resolve API base. Same-origin via Next rewrites.
  const apiBase = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return window.location.origin;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${apiBase}/v1/buy-approve/${token}/info`);
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (!cancelled) setInfo({ status: 'error', error: j.error || `HTTP ${r.status}` });
          return;
        }
        const j = await r.json();
        const data = (j.data ?? j) as Info;
        if (cancelled) return;
        setInfo(data);
        if (data.status === 'awaiting_payment') {
          setStripePromise(loadStripe((data as InfoAwaiting).publishable_key));
        }
      } catch (e: any) {
        if (!cancelled) setInfo({ status: 'error', error: e?.message ?? 'Network error' });
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, token]);

  // ───────────────────────── render branches ─────────────────────────

  if (!info) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="ml-3 text-sm">Loading order…</span>
        </div>
      </Shell>
    );
  }

  if (info.status === 'error') {
    return (
      <Shell>
        <Card>
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-6 w-6 shrink-0 text-amber-500" />
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Can't load this order</h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{(info as any).error}</p>
            </div>
          </div>
        </Card>
      </Shell>
    );
  }

  if (info.status === 'rejected') {
    return (
      <Shell>
        <Card accent="rose">
          <p className="font-semibold text-slate-900 dark:text-slate-100">Order denied</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">This approval was previously denied.</p>
        </Card>
      </Shell>
    );
  }

  if (info.status === 'expired') {
    return (
      <Shell>
        <Card accent="rose">
          <p className="font-semibold text-slate-900 dark:text-slate-100">Approval link expired</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Ask your agent to start a new order.</p>
        </Card>
      </Shell>
    );
  }

  if (info.status === 'executed') {
    return (
      <Shell>
        <Header />
        <Card accent="emerald">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
              <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">Order placed at {info.merchant}</div>
              <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                Charged {info.currency} {info.total.toFixed(2)} to {info.receipt.card_brand ?? 'card'} •••• {info.receipt.card_last4 ?? '••••'}
              </div>
            </div>
          </div>
          {info.receipt.stripe_payment_intent_id && (
            <a
              href={stripeReceiptUrl(info.receipt.stripe_payment_intent_id)}
              target="_blank" rel="noopener"
              className="mt-3 inline-flex items-center gap-1 rounded-lg bg-[#635bff] px-3 py-1.5 text-sm font-medium text-white"
            >
              View on Stripe <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </Card>
      </Shell>
    );
  }

  // ───────────────────────── awaiting_payment ─────────────────────────

  if (info.status !== 'awaiting_payment') {
    return null; // unreachable: all other branches handled above
  }

  return (
    <Shell>
      <Header />

      <Card>
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-amber-200 to-orange-300 text-lg font-semibold text-orange-800">
            {info.merchant.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-slate-900 dark:text-slate-100">{info.merchant}</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
              <MapPin className="h-3 w-3" />
              <span className="truncate">requested by {info.agent}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Order</div>
        <div className="mt-3 space-y-2">
          {info.items.map((item, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 text-sm">
              <div className="min-w-0 flex-1">
                <span className="text-slate-700 dark:text-slate-300">{item.quantity}× </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">{item.name}</span>
              </div>
              <div className="font-mono text-slate-700 dark:text-slate-300">
                {info.currency} {Number(item.total ?? (item.price ?? 0) * item.quantity).toFixed(2)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-medium text-slate-600 dark:text-slate-400">Total</div>
            <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {info.currency} {info.total.toFixed(2)}
            </div>
          </div>
        </div>
        {info.reason && (
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {info.reason}
          </div>
        )}
      </Card>

      {stripePromise && (
        <Elements
          stripe={stripePromise}
          options={{
            clientSecret: info.payment_intent_client_secret,
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
          <PayForm token={token} apiBase={apiBase} total={info.total} currency={info.currency} />
        </Elements>
      )}

      <p className="mt-4 flex items-center justify-center gap-1 text-xs text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5" />
        Secured by Stripe — PCI-compliant
      </p>
      <p className="mt-1 text-center text-[11px] text-slate-400">
        Test card: 4242 4242 4242 4242 · any future date · any CVC
      </p>
    </Shell>
  );
}

function PayForm({ token, apiBase, total, currency }: { token: string; apiBase: string; total: number; currency: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ piId: string | null; brand: string | null; last4: string | null; merchant: string } | null>(null);

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
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });
    if (error) {
      setErrMsg(error.message || 'Card charge failed.');
      setSubmitting(false);
      return;
    }
    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      setErrMsg(`Payment did not succeed (${paymentIntent?.status ?? 'unknown'}).`);
      setSubmitting(false);
      return;
    }
    // Tell our backend to finalize.
    const r = await fetch(`${apiBase}/v1/buy-approve/${token}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_intent_id: paymentIntent.id }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErrMsg(j.error || `Finalize failed (${r.status})`);
      setSubmitting(false);
      return;
    }
    const j = await r.json();
    const data = j.data ?? j;
    setDone({
      piId: data.charge?.id ?? paymentIntent.id,
      brand: data.charge?.brand ?? null,
      last4: data.charge?.last4 ?? null,
      merchant: data.merchant,
    });
  }

  if (done) {
    return (
      <Card accent="emerald">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
            <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <div className="font-semibold text-slate-900 dark:text-slate-100">Order placed at {done.merchant}</div>
            <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
              Charged {currency} {total.toFixed(2)} to {done.brand ?? 'card'} •••• {done.last4 ?? '••••'}
            </div>
          </div>
        </div>
        {done.piId && (
          <a
            href={stripeReceiptUrl(done.piId)}
            target="_blank" rel="noopener"
            className="mt-3 inline-flex items-center gap-1 rounded-lg bg-[#635bff] px-3 py-1.5 text-sm font-medium text-white"
          >
            View on Stripe <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <PaymentElement options={{ layout: 'tabs' }} />
      </Card>
      {errMsg && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{errMsg}</p>}
      <button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-slate-800 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Charging…
          </>
        ) : (
          <>Pay {currency} {total.toFixed(2)}</>
        )}
      </button>
    </form>
  );
}

function Header() {
  return (
    <div className="mb-6 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Sly</div>
      </div>
      <div className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Bot className="h-3 w-3" />
        <span>Agent checkout</span>
      </div>
    </div>
  );
}

// Build a Stripe Dashboard URL for the test-mode PI. NEXT_PUBLIC_STRIPE_ACCOUNT_ID
// is optional — when set the link lands directly in the right account;
// otherwise Stripe routes to the user's most-recently-used account.
function stripeReceiptUrl(piId: string | null | undefined): string {
  if (!piId) return '#';
  const acct = process.env.NEXT_PUBLIC_STRIPE_ACCOUNT_ID || '';
  return `https://dashboard.stripe.com${acct ? '/' + acct : ''}/test/payments/${piId}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 dark:bg-slate-950 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-md space-y-3">{children}</div>
    </div>
  );
}

function Card({ children, accent }: { children: React.ReactNode; accent?: 'emerald' | 'rose' }) {
  const accentClass =
    accent === 'emerald'
      ? 'border-emerald-200 dark:border-emerald-900'
      : accent === 'rose'
      ? 'border-rose-200 dark:border-rose-900'
      : 'border-slate-200 dark:border-slate-800';
  return (
    <div className={`rounded-2xl border bg-white p-4 shadow-sm dark:bg-slate-900 ${accentClass}`}>
      {children}
    </div>
  );
}
