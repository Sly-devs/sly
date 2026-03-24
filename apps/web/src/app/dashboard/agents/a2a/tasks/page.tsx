'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  Filter,
  FileText,
  CheckCircle,
  DollarSign,
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Network,
} from 'lucide-react';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { formatDate, formatCurrency } from '@/lib/utils';
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

function DirectionBadge({ direction }: { direction: string }) {
  if (direction === 'inbound') {
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

export default function A2ATasksPage() {
  const api = useApiClient();
  const { apiEnvironment } = useApiConfig();
  const searchParams = useSearchParams();
  const initialContextId = searchParams.get('context_id') || undefined;

  const [page, setPage] = useState(1);
  const [state, setState] = useState<string>('all');
  const [direction, setDirection] = useState<string>('all');
  const [search, setSearch] = useState('');

  const { data: rawData, isLoading } = useQuery({
    queryKey: ['a2a-tasks', page, state, direction, search, initialContextId, apiEnvironment],
    queryFn: () =>
      api!.a2a.listTasks({
        page,
        limit: 20,
        state: state === 'all' ? undefined : (state as any),
        direction: direction === 'all' ? undefined : (direction as any),
        contextId: initialContextId,
      }),
    enabled: !!api,
  });

  const { data: stats } = useQuery({
    queryKey: ['a2a-stats', apiEnvironment],
    queryFn: () => api!.a2a.getStats(),
    enabled: !!api,
  });

  const tasks = (rawData as any)?.data || [];
  const pagination = (rawData as any)?.pagination;
  const statsData = stats as any;

  // Client-side search filter
  const filteredTasks = search
    ? tasks.filter((t: any) =>
        t.id?.toLowerCase().includes(search.toLowerCase()) ||
        t.agentName?.toLowerCase().includes(search.toLowerCase())
      )
    : tasks;

  return (
    <div className="p-8 space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">A2A Tasks</h1>
          <p className="text-muted-foreground">
            Agent-to-Agent protocol tasks across all agents.
            {initialContextId && (
              <span className="ml-2 text-sm">
                Filtered by session: <code className="text-xs bg-muted px-1 py-0.5 rounded">{initialContextId.slice(0, 8)}...</code>
                <Link href="/dashboard/agents/a2a/tasks" className="ml-2 text-blue-600 hover:underline text-xs">
                  Clear filter
                </Link>
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      {statsData && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Total Tasks</p>
                  <p className="text-2xl font-bold mt-1">{statsData.total ?? 0}</p>
                </div>
                <Network className="h-8 w-8 text-blue-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Active</p>
                  <p className="text-2xl font-bold mt-1 text-amber-600">{statsData.active ?? 0}</p>
                </div>
                <Activity className="h-8 w-8 text-amber-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Completed</p>
                  <p className="text-2xl font-bold mt-1 text-emerald-600">{statsData.completed ?? 0}</p>
                </div>
                <CheckCircle className="h-8 w-8 text-emerald-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Total Cost</p>
                  <p className="text-2xl font-bold mt-1">{formatCurrency(statsData.totalCost ?? 0, 'USDC')}</p>
                </div>
                <DollarSign className="h-8 w-8 text-blue-500" />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row gap-4 justify-between">
            <div className="relative w-full md:w-96">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by task ID or agent..."
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={state} onValueChange={setState}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All States</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="working">Working</SelectItem>
                  <SelectItem value="input-required">Input Required</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="canceled">Canceled</SelectItem>
                </SelectContent>
              </Select>
              <Select value={direction} onValueChange={setDirection}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Direction" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Directions</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                  <SelectItem value="outbound">Outbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task ID</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>Session</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      Loading tasks...
                    </TableCell>
                  </TableRow>
                ) : filteredTasks.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      No A2A tasks found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTasks.map((task: any) => (
                    <TableRow key={task.id} className="cursor-pointer hover:bg-muted/50">
                      <TableCell className="font-medium">
                        <Link
                          href={`/dashboard/agents/a2a/tasks/${task.id}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {task.id.slice(0, 8)}...
                        </Link>
                      </TableCell>
                      <TableCell>{task.agentName || <span className="text-muted-foreground">--</span>}</TableCell>
                      <TableCell>
                        <DirectionBadge direction={task.direction} />
                      </TableCell>
                      <TableCell>
                        <StateBadge state={task.state} />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{task.messageCount ?? 0}</span>
                      </TableCell>
                      <TableCell>
                        {task.contextId ? (
                          <Link
                            href={`/dashboard/agents/a2a/tasks?context_id=${task.contextId}`}
                            className="font-mono text-xs text-blue-600 hover:underline"
                          >
                            {task.contextId.slice(0, 8)}...
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {task.transferAmount != null ? (
                          <Link
                            href={`/dashboard/transfers/${task.transferId}`}
                            className="text-sm font-medium text-blue-600 hover:underline"
                          >
                            {formatCurrency(task.transferAmount, task.transferCurrency || 'USD')}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDate(task.createdAt, { hour: 'numeric', minute: '2-digit' })}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {pagination && pagination.total > 0 && (
            <div className="flex items-center justify-between px-2 py-4">
              <div className="text-sm text-muted-foreground">
                Showing {(page - 1) * 20 + 1}-{Math.min(page * 20, pagination.total)} of {pagination.total} tasks
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <div className="text-sm font-medium">
                  Page {page} of {Math.ceil(pagination.total / 20)}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page + 1)}
                  disabled={page >= Math.ceil(pagination.total / 20)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
