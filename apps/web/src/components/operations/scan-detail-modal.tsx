'use client';

import { useQuery } from '@tanstack/react-query';
import { X, ExternalLink, AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useScannerApi } from '@/lib/scanner-api';

interface ProtocolResult {
  protocol: string;
  detected: boolean;
  status: string;
  confidence: string;
  capabilities: Record<string, unknown>;
  response_time_ms: number;
}

interface MerchantScan {
  id: string;
  tenant_id: string;
  domain: string;
  url: string;
  merchant_name: string | null;
  merchant_category: string | null;
  country_code: string | null;
  region: string | null;
  readiness_score: number | null;
  protocol_score: number | null;
  data_score: number | null;
  accessibility_score: number | null;
  checkout_score: number | null;
  scan_status: string;
  scan_duration_ms: number | null;
  scan_version: string | null;
  business_model: string | null;
  last_scanned_at: string | null;
  request_id: string | null;
  protocol_results?: ProtocolResult[];
}

interface ScanDetailModalProps {
  scanId: string | null;
  onClose: () => void;
}

export function ScanDetailModal({ scanId, onClose }: ScanDetailModalProps) {
  const scanner = useScannerApi();

  const scanQuery = useQuery({
    queryKey: ['scanner', 'scan', scanId],
    enabled: !!scanId,
    queryFn: async () => {
      const res = await scanner.get(`/v1/scanner/scan/${scanId}`);
      if (!res.ok) throw new Error(`scan-fetch-failed-${res.status}`);
      return (await res.json()) as MerchantScan;
    },
    staleTime: 60_000,
  });

  return (
    <Dialog open={!!scanId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <div className="p-6">
          <DialogHeader>
            <div className="flex items-start justify-between">
              <DialogTitle className="flex items-center gap-2">
                Scan result
                {scanQuery.data?.domain && (
                  <span className="font-mono text-base text-gray-500">{scanQuery.data.domain}</span>
                )}
              </DialogTitle>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-gray-500 hover:text-gray-900 dark:hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </DialogHeader>

          {scanQuery.isLoading && (
            <div className="py-12 text-center text-sm text-gray-500">Loading scan…</div>
          )}

          {scanQuery.isError && (
            <div className="mt-4 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800 p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
              <div className="text-sm text-rose-900 dark:text-rose-200">
                Failed to load scan. The scan may have been deleted, or your session may have expired — try refreshing the page.
              </div>
            </div>
          )}

          {scanQuery.data && <ScanBody scan={scanQuery.data} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScanBody({ scan }: { scan: MerchantScan }) {
  return (
    <div className="mt-4 space-y-6">
      {/* Top stat row: readiness score + status */}
      <div className="flex items-center gap-6">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">Readiness</div>
          <div className="text-4xl font-bold text-indigo-600">
            {scan.readiness_score ?? '—'}
            <span className="text-base text-gray-400 font-normal">/100</span>
          </div>
        </div>
        <div className="space-y-1">
          <Badge variant={scan.scan_status === 'completed' ? 'ok' : 'warn'}>
            {scan.scan_status}
          </Badge>
          {scan.business_model && (
            <div className="text-xs text-gray-500">
              business model: <span className="text-gray-700 dark:text-gray-300">{scan.business_model}</span>
            </div>
          )}
          {scan.scan_duration_ms != null && (
            <div className="text-xs text-gray-500">
              took <span className="text-gray-700 dark:text-gray-300">{scan.scan_duration_ms}ms</span>
            </div>
          )}
        </div>
      </div>

      {/* Sub-scores */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SubScore label="Protocol" value={scan.protocol_score} />
        <SubScore label="Data" value={scan.data_score} />
        <SubScore label="Accessibility" value={scan.accessibility_score} />
        <SubScore label="Checkout" value={scan.checkout_score} />
      </div>

      {/* Protocol detection results */}
      {scan.protocol_results && scan.protocol_results.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
            Protocol detection
          </h3>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">Protocol</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">Status</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">Confidence</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-500 text-xs uppercase">Probe time</th>
                </tr>
              </thead>
              <tbody>
                {scan.protocol_results.map((p) => (
                  <tr key={p.protocol} className="border-t border-gray-100 dark:border-gray-700/50">
                    <td className="px-3 py-2 font-mono text-xs uppercase">{p.protocol}</td>
                    <td className="px-3 py-2">
                      <Badge variant={p.detected ? 'ok' : 'neutral'}>{p.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{p.confidence}</td>
                    <td className="px-3 py-2 text-right text-gray-500 text-xs">{p.response_time_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit trail */}
      <div className="rounded-lg bg-gray-50 dark:bg-gray-800/30 border border-gray-200 dark:border-gray-700 p-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500">Scan id</span>
          <code className="font-mono text-xs text-gray-700 dark:text-gray-300">{scan.id}</code>
        </div>
        {scan.request_id && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Request id</span>
            <code className="font-mono text-xs text-gray-700 dark:text-gray-300">{scan.request_id}</code>
          </div>
        )}
        {scan.last_scanned_at && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Scanned at</span>
            <span className="text-gray-700 dark:text-gray-300">
              {new Date(scan.last_scanned_at).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      {/* Raw payload — collapsible for power users */}
      <details className="text-sm">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-900 dark:hover:text-white inline-flex items-center gap-1">
          Raw JSON payload <ExternalLink className="h-3 w-3" />
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-gray-900 text-gray-100 p-3 text-xs">
          {JSON.stringify(scan, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function SubScore({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-xl font-semibold text-gray-900 dark:text-white">
        {value ?? '—'}
        <span className="text-xs text-gray-400 font-normal">/100</span>
      </div>
    </div>
  );
}

function Badge({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: 'ok' | 'warn' | 'neutral';
}) {
  const cls =
    variant === 'ok'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
      : variant === 'warn'
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  return (
    <span className={'inline-block text-[10px] uppercase px-1.5 py-0.5 rounded font-medium ' + cls}>
      {children}
    </span>
  );
}
