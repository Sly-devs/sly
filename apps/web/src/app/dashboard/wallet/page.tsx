/**
 * Dashboard — Buyer Wallet (Epic 88, Phase 1).
 *
 * Lists the user's saved Stripe payment methods. Lets them add a new card
 * (opens /wallet/add-card), set a default, or detach an existing card.
 */

'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import { CreditCard, Plus, ShieldCheck, Loader2, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface PaymentMethod {
  id: string;
  stripe_payment_method_id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
  created_at: string;
}

export default function WalletPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { authToken, apiUrl, isLoading: authLoading } = useApiConfig();
  const apiFetch = useApiFetch();

  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const justAdded = useMemo(() => search?.get('added') === '1', [search]);

  async function reload() {
    try {
      setLoading(true);
      const res = await apiFetch(`${apiUrl}/v1/wallet/payment-methods`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Failed to load (${res.status})`);
      }
      const json = await res.json();
      setMethods(json.data || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Network error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authLoading && authToken) reload();
  }, [authLoading, authToken]);

  // Webhook may take a moment to deliver after a card-add — poll briefly.
  useEffect(() => {
    if (!justAdded) return;
    let attempts = 0;
    const t = setInterval(async () => {
      attempts++;
      await reload();
      if (methods.length > 0 || attempts > 6) {
        clearInterval(t);
        if (methods.length > 0) toast.success('Card saved');
        // strip ?added=1 from URL once visible
        router.replace('/dashboard/wallet');
      }
    }, 1500);
    return () => clearInterval(t);
  }, [justAdded]);

  async function setDefault(id: string) {
    setBusyId(id);
    try {
      const res = await apiFetch(`${apiUrl}/v1/wallet/payment-methods/${id}`, { method: 'PATCH' });
      if (!res.ok) throw new Error('Could not set default');
      await reload();
      toast.success('Default updated');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function detach(id: string) {
    if (!confirm('Remove this card?')) return;
    setBusyId(id);
    try {
      const res = await apiFetch(`${apiUrl}/v1/wallet/payment-methods/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not remove card');
      await reload();
      toast.success('Card removed');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Wallet</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Cards your agents can charge for checkouts. Stored with Stripe — Sly never sees the number.
            </p>
          </div>
          <Link
            href="/wallet/add-card"
            className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            <Plus className="h-4 w-4" />
            Add card
          </Link>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : methods.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2">
            {methods.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
              >
                <div className="flex h-10 w-14 items-center justify-center rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700">
                  <CreditCard className="h-5 w-5 text-slate-600 dark:text-slate-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium capitalize text-gray-900 dark:text-white">
                      {m.brand ?? 'Card'}
                    </span>
                    <span className="font-mono text-gray-500 dark:text-gray-400">
                      •••• {m.last4 ?? '••••'}
                    </span>
                    {m.is_default && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        <Star className="h-2.5 w-2.5 fill-current" /> Default
                      </span>
                    )}
                  </div>
                  {(m.exp_month || m.exp_year) && (
                    <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      Exp{' '}
                      {m.exp_month?.toString().padStart(2, '0')}/{m.exp_year?.toString().slice(-2)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {!m.is_default && (
                    <button
                      type="button"
                      onClick={() => setDefault(m.id)}
                      disabled={busyId === m.id}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                    >
                      Make default
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => detach(m.id)}
                    disabled={busyId === m.id}
                    className="rounded-lg p-2 text-gray-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-950"
                    aria-label="Remove card"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-gray-400">
          <ShieldCheck className="h-3.5 w-3.5" />
          PCI-compliant — cards stored with Stripe, never on Sly servers
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white p-12 text-center dark:border-gray-800 dark:bg-gray-900">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 dark:bg-gray-800">
        <CreditCard className="h-6 w-6 text-gray-400" />
      </div>
      <h2 className="text-base font-medium text-gray-900 dark:text-white">No cards yet</h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Add a card so your agents can complete checkouts on your behalf.
      </p>
      <Link
        href="/wallet/add-card"
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
      >
        <Plus className="h-4 w-4" />
        Add card
      </Link>
    </div>
  );
}
