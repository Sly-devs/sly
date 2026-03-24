'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  MessageSquare,
  FileText,
  Network,
  DollarSign,
  Copy,
  ExternalLink,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Activity,
  Bot,
} from 'lucide-react';
import { useApiClient, useApiConfig } from '@/lib/api-client';
import { formatDate, formatCurrency } from '@/lib/utils';
import { MessageBubble } from '@/components/agents/message-bubble';
import { SessionTimeline } from '@/components/agents/session-timeline';
import {
  Card,
  CardContent,
  Button,
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

export default function SessionDetailPage({ params }: { params: Promise<{ contextId: string }> }) {
  const { contextId } = use(params);
  const api = useApiClient();
  const { apiEnvironment } = useApiConfig();
  const router = useRouter();

  const { data: session, isLoading, error } = useQuery({
    queryKey: ['a2a-session', contextId, apiEnvironment],
    queryFn: () => api!.a2a.getSession(contextId),
    enabled: !!api,
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

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

  if (!session || error) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <p className="text-muted-foreground">Session not found</p>
          <Button variant="outline" className="mt-4" onClick={() => router.back()}>
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  const { tasks, messages, artifacts, events, summary, agents: sessionAgents } = session as any;

  const callerAgent = (sessionAgents || []).find((a: any) => a.role === 'caller');
  const providerAgent = (sessionAgents || []).find((a: any) => a.role === 'provider');

  return (
    <div className="p-8 space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/dashboard/agents/a2a/sessions" className="hover:text-foreground flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Sessions
        </Link>
        <span>/</span>
        <span className="font-mono text-xs">{contextId.slice(0, 16)}...</span>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Session Conversation</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="font-mono text-xs text-muted-foreground">{contextId}</span>
            <button onClick={() => copyToClipboard(contextId)} className="p-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded">
              <Copy className="h-3 w-3 text-gray-400" />
            </button>
          </div>
        </div>
      </div>

      {/* Agents involved */}
      {(callerAgent || providerAgent) && (
        <div className="flex items-center gap-3 flex-wrap">
          {callerAgent && (
            <Link
              href={`/dashboard/agents/${callerAgent.id}`}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-muted/50 transition-colors"
            >
              <Bot className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-medium">{callerAgent.name || 'Unknown Agent'}</span>
              <span className="text-[10px] text-muted-foreground">caller</span>
            </Link>
          )}
          {callerAgent && providerAgent && (
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          )}
          {providerAgent && (
            <Link
              href={`/dashboard/agents/${providerAgent.id}`}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-muted/50 transition-colors"
            >
              <Bot className="h-4 w-4 text-purple-500" />
              <span className="text-sm font-medium">{providerAgent.name || 'Unknown Agent'}</span>
              <span className="text-[10px] text-muted-foreground">provider</span>
            </Link>
          )}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Tasks</p>
                <p className="text-2xl font-bold mt-1">{summary?.taskCount || 0}</p>
              </div>
              <Network className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Messages</p>
                <p className="text-2xl font-bold mt-1">{summary?.messageCount || 0}</p>
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
                <p className="text-2xl font-bold mt-1">{formatCurrency(summary?.totalCost || 0, summary?.totalCostCurrency || 'USDC')}</p>
              </div>
              <DollarSign className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Duration</p>
                <p className="text-sm font-medium mt-1 text-muted-foreground">
                  {summary?.firstActivity ? formatDate(summary.firstActivity) : '--'}
                </p>
                <p className="text-sm font-medium text-muted-foreground">
                  {summary?.lastActivity ? formatDate(summary.lastActivity) : '--'}
                </p>
              </div>
              <Clock className="h-8 w-8 text-gray-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Two-column layout: sticky timeline sidebar + main content */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Timeline Sidebar — sticky on desktop, scrolls independently */}
        {events && events.length > 0 && (
          <div className="lg:w-[340px] lg:shrink-0">
            <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:[scrollbar-width:thin]">
              <Card>
                <CardContent className="pt-6">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Activity className="h-4 w-4 text-blue-500" />
                    Timeline ({events.length})
                  </h3>
                  <SessionTimeline events={events} compact />
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* Tasks in this session */}
          <Card>
            <CardContent className="pt-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <Network className="h-4 w-4 text-blue-500" />
                Tasks ({tasks?.length || 0})
              </h3>
              <div className="space-y-2">
                {(tasks || []).map((task: any) => (
                  <Link
                    key={task.id}
                    href={`/dashboard/agents/a2a/tasks/${task.id}`}
                    className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {task.direction === 'inbound' ? (
                        <ArrowDownLeft className="h-4 w-4 text-blue-500" />
                      ) : (
                        <ArrowUpRight className="h-4 w-4 text-purple-500" />
                      )}
                      <div>
                        <span className="text-sm font-medium">{task.agentName || 'Unknown Agent'}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{task.id.slice(0, 8)}...</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StateBadge state={task.state} />
                      {task.transferId && (
                        <DollarSign className="h-3.5 w-3.5 text-blue-400" />
                      )}
                      <ExternalLink className="h-3.5 w-3.5 text-gray-400" />
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Conversation Thread */}
          <Card>
            <CardContent className="pt-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-blue-500" />
                Conversation ({messages?.length || 0} messages)
              </h3>
              <div className="space-y-3">
                {(messages || []).map((msg: any) => (
                  <MessageBubble
                    key={msg.messageId}
                    role={msg.role}
                    parts={msg.parts}
                    taskId={msg.taskId}
                    createdAt={msg.createdAt}
                  />
                ))}
                {(!messages || messages.length === 0) && (
                  <p className="text-sm text-gray-500 text-center py-8">No messages in this session</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Artifacts */}
          {artifacts && artifacts.length > 0 && (
            <Card>
              <CardContent className="pt-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                  <FileText className="h-5 w-5 text-purple-500" />
                  Artifacts ({artifacts.length})
                </h3>
                <div className="space-y-3">
                  {artifacts.map((artifact: any) => (
                    <div key={artifact.artifactId} className="p-4 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900 dark:text-white">
                            {artifact.name || 'Untitled'}
                          </span>
                          <Link
                            href={`/dashboard/agents/a2a/tasks/${artifact.taskId}`}
                            className="text-[10px] font-mono text-gray-400 hover:text-blue-500"
                          >
                            {artifact.taskId.slice(0, 8)}
                          </Link>
                        </div>
                        <span className="text-xs text-gray-500">{formatDate(artifact.createdAt)}</span>
                      </div>
                      {(artifact.parts || []).map((part: any, i: number) => (
                        <div key={i}>
                          {'text' in part && part.text && (
                            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{part.text}</p>
                          )}
                          {'data' in part && part.data && (
                            <pre className="text-xs font-mono text-gray-600 dark:text-gray-400 overflow-x-auto">
                              {JSON.stringify(part.data, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
