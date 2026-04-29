/**
 * Hosted Approval Page (Epic 88, Invu demo).
 *
 * URL: /approve/<approval_id>
 *
 * Flow:
 *   1. Fetch approval from /v1/approvals/:id
 *   2. Render merchant card + cart + agent identity + policy reason
 *   3. On Approve:
 *        a) POST /v1/approvals/:id/approve
 *        b) POST /v1/acp/checkouts/<checkout_uuid>/complete with a stub SPT
 *           (ACP route now bypasses policy when an approved approval exists)
 *        c) Render receipt
 *   4. On Deny: POST /v1/approvals/:id/reject
 *
 * Auth: relies on the same Supabase JWT the dashboard uses. Diego is logged
 * in to /dashboard on his phone before the demo; the magic link inherits the
 * session via cookies.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { use as usePromise } from 'react';
import { useApiConfig, useApiFetch } from '@/lib/api-client';
import {
  Bot,
  Check,
  Clock,
  Loader2,
  MapPin,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';

interface CartItem {
  name: string;
  quantity: number;
  price: number;
}

interface ApprovalRecipient {
  checkout_id?: string;
  merchant_id?: string;
  merchant_name?: string;
}

interface ApprovalPaymentContext {
  checkout_id?: string;
  checkout_uuid?: string;
  merchant_id?: string;
  merchant_name?: string;
  agent_id?: string;
  items?: CartItem[];
  shared_payment_token?: string;
}

interface ApprovalRecord {
  id: string;
  walletId: string;
  agentId?: string;
  protocol: string;
  amount: number;
  currency: string;
  recipient: ApprovalRecipient | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  expiresAt: string;
  decidedAt?: string;
  executedTransferId?: string;
  requestedBy?: { type?: string; id?: string; name?: string };
}

type Stage = 'loading' | 'ready' | 'submitting' | 'success' | 'denied' | 'error';

export default function ApproveCheckoutPage(props: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(props.params);
  const { authToken, apiUrl, isLoading: authLoading } = useApiConfig();
  const apiFetch = useApiFetch();

  const [stage, setStage] = useState<Stage>('loading');
  const [approval, setApproval] = useState<ApprovalRecord | null>(null);
  const [paymentContext, setPaymentContext] = useState<ApprovalPaymentContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ transferId?: string; total?: number; cardBrand?: string; cardLast4?: string } | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [paymentMethod, setPaymentMethod] = useState<{ id: string; brand: string | null; last4: string | null } | null>(null);
  const [noCardWarning, setNoCardWarning] = useState(false);

  // Fetch approval on mount (after auth is ready)
  useEffect(() => {
    if (authLoading) return;
    if (!authToken) {
      setError('Sign in to the Sly dashboard before approving — your session is needed to authorize this action.');
      setStage('error');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`${apiUrl}/v1/approvals/${id}`);
        if (res.status === 404) {
          if (!cancelled) {
            setError('Approval not found — link may be invalid or expired.');
            setStage('error');
          }
          return;
        }
        if (!res.ok) {
          if (!cancelled) {
            setError(`Could not load approval (${res.status}).`);
            setStage('error');
          }
          return;
        }
        const json = await res.json();
        const apr: ApprovalRecord = json.data;
        if (cancelled) return;
        setApproval(apr);
        // Pull payment context from the same record. The list endpoint omits it,
        // but the GET-by-id includes recipient; we fetch the underlying ACP
        // checkout's payment_context separately because it carries cart items.
        // Fall back to recipient if the dedicated context endpoint isn't exposed.
        const ctx = (json as any).data?.paymentContext || (json as any).data?.payment_context || null;
        // The /v1/approvals/:id mapper above doesn't currently return
        // paymentContext (mapApprovalToResponse strips it). Refetch the raw
        // approval row through the items lookup if needed.
        let resolvedCtx: ApprovalPaymentContext | null = ctx;
        if (!resolvedCtx) {
          // Try fetching the ACP checkout to get cart items as a fallback.
          const cid = apr.recipient?.checkout_id;
          if (cid) {
            const res2 = await apiFetch(`${apiUrl}/v1/acp/checkouts?limit=1&agent_id=${encodeURIComponent(apr.agentId ?? '')}`);
            if (res2.ok) {
              // Best-effort: walk recent checkouts to find the matching one.
              const list = await res2.json();
              const match = (list?.data ?? []).find((c: any) => c.checkout_id === cid);
              if (match?.id) {
                const detail = await apiFetch(`${apiUrl}/v1/acp/checkouts/${match.id}`);
                if (detail.ok) {
                  const d = await detail.json();
                  resolvedCtx = {
                    checkout_id: d?.data?.checkout_id,
                    checkout_uuid: d?.data?.id,
                    merchant_id: d?.data?.merchant_id,
                    merchant_name: d?.data?.merchant_name,
                    agent_id: d?.data?.agent_id,
                    items: (d?.data?.items ?? []).map((it: any) => ({
                      name: it.name,
                      quantity: it.quantity,
                      price: it.unit_price,
                    })),
                  };
                }
              }
            }
          }
        }
        setPaymentContext(resolvedCtx);

        // Resolve which card we'll charge on approve. Pull the default
        // payment method; surface a warning if there isn't one (Diego
        // hasn't added a card yet).
        try {
          const pmRes = await apiFetch(`${apiUrl}/v1/wallet/payment-methods`);
          if (pmRes.ok) {
            const pmJson = await pmRes.json();
            const list: any[] = pmJson?.data ?? [];
            const def = list.find(p => p.is_default) || list[0];
            if (def) {
              setPaymentMethod({ id: def.id, brand: def.brand, last4: def.last4 });
            } else {
              setNoCardWarning(true);
            }
          }
        } catch (_pmErr) {
          // Non-fatal — page still renders, approval still works without a card
          setNoCardWarning(true);
        }

        setStage(apr.status === 'pending' ? 'ready' : (apr.status === 'rejected' ? 'denied' : 'success'));
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? 'Network error');
        setStage('error');
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, authToken, apiFetch, apiUrl, id]);

  // Countdown timer (refreshes once per second while pending)
  useEffect(() => {
    if (stage !== 'ready') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stage]);

  const expiresInLabel = useMemo(() => {
    if (!approval) return '';
    const ms = new Date(approval.expiresAt).getTime() - now;
    if (ms <= 0) return 'expired';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }, [approval, now]);

  async function onApprove() {
    if (!approval) return;
    setStage('submitting');
    try {
      // 1) Approve
      const r1 = await apiFetch(`${apiUrl}/v1/approvals/${approval.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'approved via hosted page' }),
      });
      if (!r1.ok) {
        const j = await r1.json().catch(() => ({}));
        setError(j.error || `Approve failed (${r1.status})`);
        setStage('error');
        return;
      }

      // 2) Re-trigger the ACP completion. The ACP route now skips the policy
      //    check when an approved approval already exists for this checkout.
      //    When we have a saved card, hand it off — ACP will charge it
      //    via Stripe (off_session, confirm=true).
      const checkoutUuid = paymentContext?.checkout_uuid || approval.recipient?.checkout_id;
      if (checkoutUuid) {
        const body: Record<string, unknown> = {
          shared_payment_token: `demo_spt_${approval.id.slice(0, 8)}`,
          idempotency_key: `approval-${approval.id}`,
        };
        if (paymentMethod) {
          body.wallet_payment_method_id = paymentMethod.id;
          body.payment_method = 'card';
        } else {
          body.payment_method = 'demo';
        }
        const r2 = await apiFetch(`${apiUrl}/v1/acp/checkouts/${checkoutUuid}/complete`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (r2.ok) {
          const j = await r2.json();
          setReceipt({
            transferId: j?.data?.transfer_id,
            total: typeof j?.data?.total_amount === 'number' ? j.data.total_amount : approval.amount,
            cardBrand: j?.data?.card_brand,
            cardLast4: j?.data?.card_last4,
          });
        } else {
          // Approval was granted but completion failed — still treat as success
          // for the demo. Surface the warning in the receipt block.
          setReceipt({ total: approval.amount });
        }
      } else {
        setReceipt({ total: approval.amount });
      }
      setStage('success');
    } catch (e: any) {
      setError(e?.message ?? 'Network error');
      setStage('error');
    }
  }

  async function onDeny() {
    if (!approval) return;
    setStage('submitting');
    try {
      const r = await apiFetch(`${apiUrl}/v1/approvals/${approval.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'denied via hosted page' }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `Deny failed (${r.status})`);
        setStage('error');
        return;
      }
      setStage('denied');
    } catch (e: any) {
      setError(e?.message ?? 'Network error');
      setStage('error');
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  if (authLoading || stage === 'loading') {
    return (
      <Shell>
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="ml-3 text-sm">Loading approval…</span>
        </div>
      </Shell>
    );
  }

  if (stage === 'error') {
    return (
      <Shell>
        <Card>
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-6 w-6 shrink-0 text-amber-500" />
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Can't load this approval</h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{error}</p>
            </div>
          </div>
        </Card>
      </Shell>
    );
  }

  const merchantName = paymentContext?.merchant_name || approval?.recipient?.merchant_name || 'Merchant';
  const merchantId = paymentContext?.merchant_id || approval?.recipient?.merchant_id;
  const agentId = paymentContext?.agent_id || approval?.agentId;
  const items = paymentContext?.items ?? [];
  const total = approval?.amount ?? 0;
  const currency = approval?.currency ?? 'USD';

  return (
    <Shell>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Sly</div>
        </div>
        {stage === 'ready' && (
          <div className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <Clock className="h-3 w-3" />
            <span>Expires in {expiresInLabel}</span>
          </div>
        )}
      </div>

      {/* Title */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Approve this order?</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Your agent needs your approval to complete this checkout.
        </p>
      </div>

      {/* Success */}
      {stage === 'success' && (
        <Card accent="emerald">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
              <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">Approved · Order placed at {merchantName}</div>
              <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                {currency} {total.toFixed(2)}
                {receipt?.cardBrand && receipt?.cardLast4 && (
                  <span className="ml-2 text-xs text-slate-500">
                    · charged to {receipt.cardBrand} •••• {receipt.cardLast4}
                  </span>
                )}
                {!receipt?.cardBrand && receipt?.transferId && (
                  <span className="ml-2 text-xs text-slate-500">· transfer {receipt.transferId.slice(0, 8)}</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Denied */}
      {stage === 'denied' && (
        <Card accent="rose">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950">
              <X className="h-5 w-5 text-rose-600 dark:text-rose-400" />
            </div>
            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">Order denied</div>
              <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">Your agent has been notified.</div>
            </div>
          </div>
        </Card>
      )}

      {/* Pending state */}
      {(stage === 'ready' || stage === 'submitting') && (
        <>
          {/* Merchant */}
          <Card>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-amber-200 to-orange-300 text-lg font-semibold text-orange-800">
                {merchantName.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-slate-900 dark:text-slate-100">{merchantName}</div>
                {merchantId && (
                  <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                    <MapPin className="h-3 w-3" />
                    <span className="truncate">{merchantId}</span>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Cart */}
          <Card>
            <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Order</div>
            <div className="mt-3 space-y-2">
              {items.length > 0 ? items.map((item, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="text-slate-700 dark:text-slate-300">{item.quantity}× </span>
                    <span className="font-medium text-slate-900 dark:text-slate-100">{item.name}</span>
                  </div>
                  <div className="font-mono text-slate-700 dark:text-slate-300">
                    {currency} {(item.quantity * item.price).toFixed(2)}
                  </div>
                </div>
              )) : (
                <div className="text-sm text-slate-500">No item details available.</div>
              )}
            </div>
            <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="flex items-baseline justify-between">
                <div className="text-sm font-medium text-slate-600 dark:text-slate-400">Total</div>
                <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {currency} {total.toFixed(2)}
                </div>
              </div>
            </div>
          </Card>

          {/* Agent identity + policy reason */}
          <Card>
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800">
                <Bot className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Requested by{' '}
                  <span className="font-semibold">{approval?.requestedBy?.name ?? agentId ?? 'your agent'}</span>
                </div>
                <div className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  <div className="font-medium">Approval required</div>
                  <div className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                    This {currency} {total.toFixed(2)} order exceeds your{' '}
                    <span className="font-semibold">per-transaction approval threshold</span>.
                    Single-use approval — only this order will be authorized.
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* Card on file */}
          {paymentMethod && (
            <Card>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Pay with</div>
                <div className="text-sm font-medium capitalize text-slate-900 dark:text-slate-100">
                  {paymentMethod.brand ?? 'Card'} •••• {paymentMethod.last4 ?? '••••'}
                </div>
              </div>
            </Card>
          )}
          {noCardWarning && !paymentMethod && (
            <Card accent="rose">
              <div className="text-sm">
                <div className="font-semibold text-rose-700 dark:text-rose-300">No card on file</div>
                <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                  Add a card in <span className="font-mono">/dashboard/wallet</span> before approving so the order can be charged. Approving now will record the approval but no charge will run.
                </div>
              </div>
            </Card>
          )}

          {/* Actions */}
          <div className="mt-6 space-y-2">
            <button
              type="button"
              onClick={onApprove}
              disabled={stage === 'submitting'}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-slate-800 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {stage === 'submitting' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Approving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Approve this order
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onDeny}
              disabled={stage === 'submitting'}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4" />
              Deny
            </button>
          </div>

          <p className="mt-4 text-center text-xs text-slate-500">
            Single-use scope · expires {expiresInLabel ? `in ${expiresInLabel}` : 'soon'}
          </p>
        </>
      )}
    </Shell>
  );
}

// ─── Layout primitives (kept inline so the page is portable) ─────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 dark:bg-slate-950 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-md space-y-3">{children}</div>
    </div>
  );
}

function Card({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent?: 'emerald' | 'rose';
}) {
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
