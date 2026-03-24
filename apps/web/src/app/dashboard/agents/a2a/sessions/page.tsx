'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  MessageSquare,
  Network,
  DollarSign,
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  ArrowRight,
} from 'lucide-react';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { formatDate, formatCurrency } from '@/lib/utils';
import {
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Card,
  CardContent,
  CardHeader,
} from '@sly/ui';

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    working: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
    'input-required': 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
    completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    canceled: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    rejected: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[state] || colors.canceled}`}>
      {state}
    </span>
  );
}

function DirectionIndicator({ directions }: { directions: string[] }) {
  const hasInbound = directions.includes('inbound');
  const hasOutbound = directions.includes('outbound');

  if (hasInbound && hasOutbound) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
        <ArrowLeftRight className="h-3 w-3" /> Both
      </span>
    );
  }
  if (hasInbound) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
        <ArrowDownLeft className="h-3 w-3" /> Inbound
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-purple-50 text-purple-700 dark:bg-purple-900 dark:text-purple-300">
      <ArrowUpRight className="h-3 w-3" /> Outbound
    </span>
  );
}

export default function A2ASessionsPage() {
  const api = useApiClient();
  const { apiEnvironment } = useApiConfig();
  const [search, setSearch] = useState('');

  const { data: rawData, isLoading } = useQuery({
    queryKey: ['a2a-sessions', apiEnvironment],
    queryFn: () => api!.a2a.listSessions(),
    enabled: !!api,
  });

  const sessions: any[] = (rawData as any) || [];

  // Compute aggregate stats
  const activeStates = ['submitted', 'working', 'input-required'];
  const totalSessions = sessions.length;
  const activeSessions = sessions.filter((s) => activeStates.includes(s.latestState)).length;
  const totalMessages = sessions.reduce((sum, s) => sum + (s.messageCount || 0), 0);
  const totalCost = sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
  const currencies = sessions.map((s: any) => s.totalCostCurrency).filter(Boolean) as string[];
  const dominantCurrency = currencies.length > 0
    ? currencies.sort((a, b) => currencies.filter(c => c === b).length - currencies.filter(c => c === a).length)[0]
    : 'USDC';

  // Client-side search filter
  const filteredSessions = search
    ? sessions.filter((s) => {
        const q = search.toLowerCase();
        return (
          s.contextId?.toLowerCase().includes(q) ||
          s.agentNames?.some((n: string) => n.toLowerCase().includes(q)) ||
          s.agents?.some((a: any) => a.name?.toLowerCase().includes(q))
        );
      })
    : sessions;

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">A2A Sessions</h1>
        <p className="text-muted-foreground">
          Conversation threads grouped by context ID with cost and message totals.
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Total Sessions</p>
                <p className="text-2xl font-bold mt-1">{totalSessions}</p>
              </div>
              <Network className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Active Sessions</p>
                <p className="text-2xl font-bold mt-1 text-amber-600">{activeSessions}</p>
              </div>
              <Activity className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Total Messages</p>
                <p className="text-2xl font-bold mt-1">{totalMessages}</p>
              </div>
              <MessageSquare className="h-8 w-8 text-purple-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Total Cost</p>
                <p className="text-2xl font-bold mt-1">{formatCurrency(totalCost, dominantCurrency)}</p>
              </div>
              <DollarSign className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="relative w-full md:w-96">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by session ID or agent name..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session ID</TableHead>
                  <TableHead>Agents</TableHead>
                  <TableHead>Tasks</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Latest State</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead className="text-right">Last Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      Loading sessions...
                    </TableCell>
                  </TableRow>
                ) : filteredSessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      No sessions found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSessions.map((session: any) => (
                    <TableRow key={session.contextId} className="cursor-pointer hover:bg-muted/50">
                      <TableCell className="font-medium">
                        <Link
                          href={`/dashboard/agents/a2a/sessions/${session.contextId}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {session.contextId.slice(0, 12)}...
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {session.agents?.length > 0 ? (
                            <>
                              {(() => {
                                const caller = session.agents.find((a: any) => a.role === 'caller');
                                const provider = session.agents.find((a: any) => a.role === 'provider');
                                return (
                                  <>
                                    {caller && (
                                      <Link
                                        href={`/dashboard/agents/${caller.id}`}
                                        className="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        {caller.name || caller.id.slice(0, 8)}
                                      </Link>
                                    )}
                                    {caller && provider && (
                                      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                    )}
                                    {provider && (
                                      <Link
                                        href={`/dashboard/agents/${provider.id}`}
                                        className="text-xs bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        {provider.name || provider.id.slice(0, 8)}
                                      </Link>
                                    )}
                                    {!caller && !provider && (
                                      <span className="text-muted-foreground">--</span>
                                    )}
                                  </>
                                );
                              })()}
                            </>
                          ) : session.agentNames?.length > 0 ? (
                            session.agentNames.map((name: string) => (
                              <span key={name} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                                {name}
                              </span>
                            ))
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium">{session.taskCount}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{session.messageCount}</span>
                      </TableCell>
                      <TableCell>
                        <DirectionIndicator directions={session.directions || []} />
                      </TableCell>
                      <TableCell>
                        <StateBadge state={session.latestState} />
                      </TableCell>
                      <TableCell>
                        {session.totalCost > 0 ? (
                          <span className="text-sm font-medium">{formatCurrency(session.totalCost, session.totalCostCurrency || 'USDC')}</span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDate(session.lastTaskAt, { hour: 'numeric', minute: '2-digit' })}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
