'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  XCircle,
  ExternalLink,
  DollarSign,
  MessageSquare,
} from 'lucide-react';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { Button, Card, CardContent } from '@sly/ui';
import { A2ATaskDetail } from '@/components/agents/a2a-task-detail';

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
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-medium ${colors[state] || colors.canceled}`}>
      {state}
    </span>
  );
}

function DirectionBadge({ direction }: { direction: string }) {
  if (direction === 'inbound') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm font-medium bg-blue-50 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
        <ArrowDownLeft className="h-3.5 w-3.5" /> Inbound
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm font-medium bg-purple-50 text-purple-700 dark:bg-purple-900 dark:text-purple-300">
      <ArrowUpRight className="h-3.5 w-3.5" /> Outbound
    </span>
  );
}

export default function A2ATaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = useApiClient();
  const { apiEnvironment } = useApiConfig();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: taskData, isLoading } = useQuery({
    queryKey: ['a2a-task', id, apiEnvironment],
    queryFn: () => api!.a2a.getTask(id),
    enabled: !!api,
  });

  const cancelMutation = useMutation({
    mutationFn: () => api!.a2a.cancelTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['a2a-task', id] });
      queryClient.invalidateQueries({ queryKey: ['a2a-tasks'] });
      queryClient.invalidateQueries({ queryKey: ['a2a-stats'] });
    },
  });

  // Fetch sibling tasks in same session if contextId exists
  const task = taskData as any;
  const contextId = task?.contextId;

  const { data: sessionTasks } = useQuery({
    queryKey: ['a2a-session-tasks', contextId, apiEnvironment],
    queryFn: () => api!.a2a.listTasks({ contextId, limit: 50 }),
    enabled: !!api && !!contextId,
  });

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <p className="text-muted-foreground">Task not found</p>
          <Button variant="outline" className="mt-4" onClick={() => router.back()}>
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  const isTerminal = ['completed', 'failed', 'canceled', 'rejected'].includes(task.status?.state);
  const siblings = ((sessionTasks as any)?.data || []).filter((t: any) => t.id !== id);

  return (
    <div className="p-8 space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard/agents/a2a/tasks" className="hover:text-foreground flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Tasks
        </Link>
        <span>/</span>
        <span className="font-mono text-xs">{id.slice(0, 12)}...</span>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold tracking-tight font-mono text-sm">
            {id}
          </h1>
          <StateBadge state={task.status?.state} />
          {task.direction && <DirectionBadge direction={task.direction} />}
        </div>
        {!isTerminal && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
          >
            <XCircle className="h-4 w-4 mr-1" />
            {cancelMutation.isPending ? 'Canceling...' : 'Cancel Task'}
          </Button>
        )}
      </div>

      {/* Cost Card */}
      {task.transferId && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <DollarSign className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-sm font-medium">Linked Transfer</p>
                <Link
                  href={`/dashboard/transfers/${task.transferId}`}
                  className="text-xs font-mono text-blue-600 hover:underline flex items-center gap-1"
                >
                  {task.transferId.slice(0, 12)}...
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session Card */}
      {contextId && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <MessageSquare className="h-5 w-5 text-purple-500" />
                <div>
                  <p className="text-sm font-medium">Session</p>
                  <p className="text-xs font-mono text-muted-foreground">{contextId}</p>
                </div>
              </div>
              <Link
                href={`/dashboard/agents/a2a/sessions/${contextId}`}
                className="text-xs text-blue-600 hover:underline flex items-center gap-1"
              >
                View session conversation
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
            {siblings.length > 0 && (
              <div className="mt-4 border-t pt-3">
                <p className="text-xs text-muted-foreground mb-2">Other tasks in this session ({siblings.length})</p>
                <div className="space-y-1">
                  {siblings.slice(0, 5).map((s: any) => (
                    <Link
                      key={s.id}
                      href={`/dashboard/agents/a2a/tasks/${s.id}`}
                      className="flex items-center justify-between text-xs hover:bg-muted/50 rounded px-2 py-1"
                    >
                      <span className="font-mono text-blue-600">{s.id.slice(0, 8)}...</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        s.state === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                        s.state === 'working' ? 'bg-amber-100 text-amber-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {s.state}
                      </span>
                    </Link>
                  ))}
                  {siblings.length > 5 && (
                    <p className="text-xs text-muted-foreground px-2">+{siblings.length - 5} more</p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reuse existing A2ATaskDetail component */}
      <A2ATaskDetail task={task} direction={task.direction} />
    </div>
  );
}
