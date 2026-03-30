'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiConfig } from '@/lib/api-client';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  User,
  Layers,
} from 'lucide-react';
import { formatCurrency } from '@sly/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

interface OperationEvent {
  id: string;
  type: string;
  source: string;
  specversion: string;
  time: string;
  category: string;
  operation: string;
  subject: string;
  actor_type: string;
  actor_id: string;
  tenant_id: string;
  protocol: string | null;
  success: boolean;
  amount_usd: string | null;
  currency: string | null;
  duration_ms: number | null;
  external_cost_usd: string | null;
  correlation_id: string | null;
  data: Record<string, unknown>;
}

const PROTOCOL_TEXT_COLORS: Record<string, string> = {
  ucp: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-900/30',
  acp: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-900/30',
  ap2: 'text-green-700 bg-green-50 dark:text-green-300 dark:bg-green-900/30',
  x402: 'text-orange-700 bg-orange-50 dark:text-orange-300 dark:bg-orange-900/30',
  a2a: 'text-pink-700 bg-pink-50 dark:text-pink-300 dark:bg-pink-900/30',
  cctp: 'text-cyan-700 bg-cyan-50 dark:text-cyan-300 dark:bg-cyan-900/30',
};

async function fetchUsage(path: string, token: string, baseUrl: string) {
  const res = await fetch(`${baseUrl}/v1/usage${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Usage API error: ${res.status}`);
  return res.json();
}

export default function OperationDetailPage() {
  const { isConfigured, isLoading: configLoading, authToken, apiKey, apiUrl } = useApiConfig();
  const token = authToken || apiKey || '';
  const params = useParams();
  const id = params.id as string;
  const [rawExpanded, setRawExpanded] = useState(false);

  // Fetch all events (we'll find our event and correlated events)
  const { data: allEventsResponse, isLoading } = useQuery<{
    data: OperationEvent[];
    pagination: { total: number };
  }>({
    queryKey: ['operation-detail', id],
    queryFn: () => fetchUsage(`/operations?limit=200`, token, apiUrl),
    enabled: isConfigured && !!token,
  });

  // Find the target event
  const allEvents = allEventsResponse?.data || [];
  const event = allEvents.find((e) => e.id === id);

  // Fetch correlated events if event has a correlation_id
  const { data: correlatedResponse } = useQuery<{
    data: OperationEvent[];
  }>({
    queryKey: ['operation-correlated', event?.correlation_id],
    queryFn: () => fetchUsage(`/operations?correlation_id=${encodeURIComponent(event!.correlation_id!)}&limit=50`, token, apiUrl),
    enabled: isConfigured && !!token && !!event?.correlation_id,
  });

  const correlatedEvents = (correlatedResponse?.data || [])
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  if (configLoading || isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="space-y-4">
          <div className="h-8 w-64 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          <div className="h-48 w-full bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link href="/dashboard/operations" className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Operations
        </Link>
        <p className="text-gray-500">Operation event not found.</p>
      </div>
    );
  }

  const hasCorrelation = correlatedEvents.length > 1;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Back link */}
      <Link href="/dashboard/operations" className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to Operations
      </Link>

      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg font-semibold text-gray-900 dark:text-white">
                {event.operation}
              </span>
              {event.protocol && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded uppercase ${PROTOCOL_TEXT_COLORS[event.protocol] || 'text-gray-600 bg-gray-100'}`}>
                  {event.protocol}
                </span>
              )}
              {event.success ? (
                <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 dark:text-green-300 dark:bg-green-900/30 px-2 py-0.5 rounded">
                  <CheckCircle2 className="h-3 w-3" /> Success
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-900/30 px-2 py-0.5 rounded">
                  <XCircle className="h-3 w-3" /> Failed
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500 font-mono">{event.subject}</p>
          </div>
          <div className="text-right space-y-1">
            <div className="flex items-center gap-1 text-sm text-gray-500">
              <Clock className="h-3.5 w-3.5" />
              {new Date(event.time).toLocaleString()}
            </div>
            {event.duration_ms != null && (
              <p className="text-xs text-gray-400">{event.duration_ms}ms</p>
            )}
          </div>
        </div>

        {/* Details grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
          <DetailField label="Category" value={event.category} />
          <DetailField label="Actor" value={`${event.actor_type} / ${event.actor_id?.slice(0, 12)}...`} />
          <DetailField
            label="Amount"
            value={event.amount_usd ? formatCurrency(parseFloat(event.amount_usd)) : '—'}
          />
          <DetailField
            label="External Cost"
            value={event.external_cost_usd ? formatCurrency(parseFloat(event.external_cost_usd)) : '—'}
          />
          {event.correlation_id && (
            <DetailField label="Correlation ID" value={event.correlation_id.slice(0, 12) + '...'} mono />
          )}
          <DetailField label="Event ID" value={event.id.slice(0, 12) + '...'} mono />
        </div>
      </div>

      {/* Request Timeline (correlated events) */}
      {hasCorrelation && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-500" />
            Request Timeline
            <span className="text-xs font-normal text-gray-500">
              ({correlatedEvents.length} events from same request)
            </span>
          </h2>
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[15px] top-0 bottom-0 w-0.5 bg-gray-200 dark:bg-gray-700" />

            <div className="space-y-4">
              {correlatedEvents.map((ce, idx) => {
                const isCurrent = ce.id === event.id;
                return (
                  <TimelineStep
                    key={ce.id}
                    event={ce}
                    index={idx + 1}
                    isCurrent={isCurrent}
                    isLast={idx === correlatedEvents.length - 1}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Raw Event JSON */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setRawExpanded(!rawExpanded)}
          className="w-full p-4 flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/30"
        >
          <span>Raw CloudEvent</span>
          {rawExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {rawExpanded && (
          <div className="p-4 pt-0">
            <pre className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 text-xs font-mono text-gray-700 dark:text-gray-300 overflow-auto max-h-[500px]">
              {JSON.stringify(event, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className={`text-sm text-gray-900 dark:text-white ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

function TimelineStep({
  event,
  index,
  isCurrent,
  isLast,
}: {
  event: OperationEvent;
  index: number;
  isCurrent: boolean;
  isLast: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative pl-10">
      {/* Dot */}
      <div className={`absolute left-[8px] w-[15px] h-[15px] rounded-full border-2 ${
        event.success
          ? 'border-green-500 bg-green-50 dark:bg-green-900/30'
          : 'border-red-500 bg-red-50 dark:bg-red-900/30'
      } ${isCurrent ? 'ring-2 ring-blue-300 dark:ring-blue-600' : ''}`} />

      <div className={`rounded-lg border p-3 ${
        isCurrent
          ? 'border-blue-300 dark:border-blue-600 bg-blue-50/50 dark:bg-blue-900/10'
          : 'border-gray-200 dark:border-gray-700'
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-mono">#{index}</span>
            <span className="font-mono text-sm text-gray-900 dark:text-white">{event.operation}</span>
            {event.success ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-red-500" />
            )}
            {event.duration_ms != null && (
              <span className="text-xs text-gray-400">{event.duration_ms}ms</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {event.amount_usd && (
              <span className="text-xs font-mono text-gray-700 dark:text-gray-300">
                {formatCurrency(parseFloat(event.amount_usd))}
              </span>
            )}
            <span className="text-xs text-gray-400">
              {new Date(event.time).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
              })}
            </span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-1 font-mono">{event.subject}</p>

        {/* Expandable data */}
        {event.data && Object.keys(event.data).length > 0 && (
          <>
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1"
            >
              {expanded ? 'Hide data' : 'Show data'}
            </button>
            {expanded && (
              <pre className="mt-2 bg-gray-50 dark:bg-gray-900 rounded p-2 text-xs font-mono text-gray-600 dark:text-gray-400 overflow-auto max-h-[200px]">
                {JSON.stringify(event.data, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
