import { useEffect, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { ScrollArea } from '../components/ui/scroll-area';
import { roleLabel } from '../lib/labels';
import { toast } from '../components/ui/use-toast';

type ControlState = {
  controlKey: string;
  value: boolean;
  companyId?: string | null;
  updatedAt?: string | null;
  updatedBy: string;
};

type RuntimeTask = {
  taskId: string;
  messageId: string;
  userId: string;
  companyId?: string | null;
  scopeVisibility?: 'resolved' | 'unresolved';
  status: string;
  currentStep?: string;
  controlSignal: 'running' | 'paused' | 'cancelled';
  engine?: 'legacy' | 'langgraph';
  configuredEngine?: 'legacy' | 'langgraph';
  engineUsed?: 'legacy' | 'langgraph';
  rolledBackFrom?: 'legacy' | 'langgraph' | null;
  rollbackReasonCode?: string | null;
  graphThreadId?: string;
  graphNode?: string;
  graphStepHistory?: string[];
  routeIntent?: string;
  plan: string[];
  latestSynthesis?: string;
  agentResultsHistory?: AgentResultHistoryEntry[];
  updatedAt: string;
};

type RuntimeTaskDetail = RuntimeTask & {
  latestCheckpoint?: {
    version: number;
    node: string;
    updatedAt: string;
  } | null;
};

type AgentResultHistoryEntry = {
  taskId: string;
  agentKey: string;
  status: 'success' | 'failed' | 'needs_context' | 'hitl_paused' | 'timed_out_partial';
  message: string;
  result?: Record<string, unknown>;
  error?: {
    type?: string;
    classifiedReason?: string;
    rawMessage?: string;
    retriable?: boolean;
  };
  metrics?: {
    latencyMs?: number;
    tokensUsed?: number;
    apiCalls?: number;
  };
};

type RuntimeTaskTrace = {
  taskId: string;
  companyId?: string | null;
  scopeVisibility?: 'resolved' | 'unresolved';
  engine: 'legacy' | 'langgraph';
  configuredEngine?: 'legacy' | 'langgraph';
  engineUsed?: 'legacy' | 'langgraph';
  rolledBackFrom?: 'legacy' | 'langgraph' | null;
  rollbackReasonCode?: string | null;
  graphThreadId?: string;
  latestNode?: string | null;
  transitions: Array<{
    version: number;
    node: string;
    updatedAt: string;
    engine: 'legacy' | 'langgraph';
    graphNode?: string;
    graphThreadId?: string;
    companyId?: string | null;
    scopeVisibility?: 'resolved' | 'unresolved';
    routeIntent?: string;
    routeSource?: string;
    routeFallbackReasonCode?: string;
    planSource?: string;
    planValidationErrors?: string[];
    responseDeliveryStatus?: string;
    recoveryMode?: string;
    resumeDecisionReason?: string;
  }>;
};

type RuntimeDependencyHealth = {
  name: 'redis' | 'qdrant' | 'queue' | 'openai' | 'zoho';
  ok: boolean;
  latencyMs?: number;
  detail?: Record<string, unknown>;
  error?: string;
};

type RuntimeHealth = {
  overall: 'ok' | 'degraded';
  generatedAt: string;
  dependencies: RuntimeDependencyHealth[];
};

export const ControlsPage = () => {
  const { token, session } = useAdminAuth();
  const [rows, setRows] = useState<ControlState[]>([]);
  const [tasks, setTasks] = useState<RuntimeTask[]>([]);
  const [runtimeTaskId, setRuntimeTaskId] = useState('');
  const [runtimeAction, setRuntimeAction] = useState<'pause' | 'resume' | 'cancel'>('pause');
  const [runtimeDetail, setRuntimeDetail] = useState<RuntimeTaskDetail | null>(null);
  const [runtimeTrace, setRuntimeTrace] = useState<RuntimeTaskTrace | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const [result, runtime, health] = await Promise.all([
        api.get<ControlState[]>('/api/admin/controls', token),
        api.get<RuntimeTask[]>('/api/admin/runtime/tasks?limit=20', token),
        api.get<RuntimeHealth>('/api/admin/runtime/health', token),
      ]);
      setRows(result);
      setTasks(runtime);
      setRuntimeHealth(health);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const apply = async (row: ControlState) => {
    if (!token) return;

    const nextValue = !row.value;
    if (!window.confirm(`Apply ${row.controlKey} = ${String(nextValue)}?`)) {
      return;
    }

    try {
      await api.post(
        '/api/admin/controls/apply',
        {
          controlKey: row.controlKey,
          requestedValue: nextValue,
          companyId: row.companyId ?? undefined,
          confirmation: 'APPLY',
        },
        token,
      );
      toast({ title: 'Success', description: `${row.controlKey} updated.`, variant: 'success' });
      await load();
    } catch {
      // Error is handled globally by api.ts toaster
    }
  };

  const applyRuntimeControl = async () => {
    if (!token || !runtimeTaskId.trim()) return;

    try {
      await api.post(
        `/api/admin/runtime/tasks/${encodeURIComponent(runtimeTaskId.trim())}/control`,
        { action: runtimeAction },
        token,
      );
      toast({ title: 'Success', description: `Task ${runtimeTaskId.trim()} -> ${runtimeAction} applied.`, variant: 'success' });
      await load();
    } catch {
      // Error handled by api.ts
    }
  };

  const recoverRuntimeTask = async () => {
    if (!token || !runtimeTaskId.trim()) return;

    try {
      await api.post(
        `/api/admin/runtime/tasks/${encodeURIComponent(runtimeTaskId.trim())}/recover`,
        {},
        token,
      );
      toast({ title: 'Success', description: `Recovery queued for task ${runtimeTaskId.trim()}.`, variant: 'success' });
      await load();
    } catch {
      // Error handled by api.ts
    }
  };

  const inspectTask = async (taskId: string) => {
    if (!token) return;
    try {
      const [detail, trace] = await Promise.all([
        api.get<RuntimeTaskDetail>(`/api/admin/runtime/tasks/${encodeURIComponent(taskId)}`, token),
        api.get<RuntimeTaskTrace>(`/api/admin/runtime/tasks/${encodeURIComponent(taskId)}/trace`, token),
      ]);
      setRuntimeDetail(detail);
      setRuntimeTrace(trace);
      setRuntimeTaskId(taskId);
    } catch {
      // Error handled globally
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-zinc-100">System Controls</CardTitle>
            <CardDescription className="text-zinc-500 mt-1">
              High-impact controls require explicit confirmation and backend audit logging.
            </CardDescription>
          </div>
          <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent shrink-0">Session role: {roleLabel(session?.role)}</Badge>
        </CardHeader>
        <CardContent className="pt-6 space-y-6">
          <div className="flex flex-col gap-2">
            {loading ? (
              <>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                    <div className="flex flex-col gap-2 w-full">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <Skeleton className="h-8 w-16 shrink-0" />
                  </div>
                ))}
              </>
            ) : (
              <>
                {rows.map((row) => (
                  <div key={row.controlKey} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                    <div className="flex flex-col">
                      <strong className="text-zinc-200 text-sm font-medium">{row.controlKey}</strong>
                      <span className="text-xs text-zinc-500 mt-1">
                        Current: <span className={row.value ? "text-emerald-400" : "text-zinc-400"}>{row.value ? 'ENABLED' : 'DISABLED'}</span> &middot; Updated by {row.updatedBy}
                      </span>
                    </div>
                    <Button variant={row.value ? "default" : "outline"} size="sm" onClick={() => void apply(row)} className={row.value ? "bg-[#2a2a2a] border border-[#3a3a3a] text-zinc-200 hover:bg-[#333]" : "border-[#222] text-zinc-400 hover:text-zinc-200 hover:bg-[#111]"}>
                      Toggle
                    </Button>
                  </div>
                ))}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">Runtime Health</CardTitle>
          <CardDescription className="text-zinc-500 mt-1">
            Backend dependency health for orchestration runtime and retrieval path.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          {loading ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map((item) => (
                <div key={item} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-32" />
                </div>
              ))}
            </div>
          ) : runtimeHealth ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-md bg-[#0a0a0a] border border-[#1a1a1a] p-3">
                <span className="text-sm text-zinc-400">Overall</span>
                <Badge variant={runtimeHealth.overall === 'ok' ? 'secondary' : 'destructive'} className={runtimeHealth.overall === 'ok' ? 'bg-[#1a1a1a] text-emerald-400' : ''}>
                  {runtimeHealth.overall.toUpperCase()}
                </Badge>
              </div>
              {runtimeHealth.dependencies.map((dependency) => (
                <div key={dependency.name} className="rounded-md bg-[#0a0a0a] border border-[#1a1a1a] p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-300 uppercase tracking-wide">{dependency.name}</span>
                    <Badge variant={dependency.ok ? 'secondary' : 'destructive'} className={dependency.ok ? 'bg-[#1a1a1a] text-emerald-400' : ''}>
                      {dependency.ok ? 'healthy' : 'degraded'}
                    </Badge>
                  </div>
                  {typeof dependency.latencyMs === 'number' ? (
                    <p className="text-xs text-zinc-500">Latency: {dependency.latencyMs}ms</p>
                  ) : null}
                  {dependency.error ? (
                    <p className="text-xs text-rose-400">{dependency.error}</p>
                  ) : null}
                  {dependency.detail ? (
                    <p className="text-xs text-zinc-500 font-mono break-all">{JSON.stringify(dependency.detail)}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500 italic">Runtime health is unavailable.</p>
          )}
        </CardContent>
      </Card>

      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">Runtime Task Control</CardTitle>
          <CardDescription className="text-zinc-500 mt-1">
            Pause, resume, or cancel orchestration tasks at safe worker boundaries.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-6">
          <div className="flex flex-col md:flex-row gap-3">
            <Input
              value={runtimeTaskId}
              onChange={(event) => setRuntimeTaskId(event.target.value)}
              placeholder="Task ID"
              className="bg-[#0a0a0a] border-[#222] md:w-64"
            />
            <Select
              value={runtimeAction}
              onValueChange={(val) => setRuntimeAction(val as 'pause' | 'resume' | 'cancel')}
            >
              <SelectTrigger className="bg-[#0a0a0a] border-[#222] md:w-40">
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                <SelectItem value="pause">pause</SelectItem>
                <SelectItem value="resume">resume</SelectItem>
                <SelectItem value="cancel">cancel</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button onClick={() => void applyRuntimeControl()} className="bg-[#2a2a2a] border border-[#3a3a3a] text-zinc-200 hover:bg-[#333]">Apply</Button>
              <Button variant="outline" onClick={() => void recoverRuntimeTask()} className="border-[#222] text-zinc-400 hover:text-zinc-200 hover:bg-[#1a1a1a]">
                Recover
              </Button>
            </div>
          </div>

          {runtimeDetail ? (
            <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-md p-4 flex flex-col gap-4">
              <div className="flex items-center justify-between pb-3 border-b border-[#1a1a1a]">
                <strong className="text-zinc-200 text-sm font-medium">Task Detail</strong>
                <Badge variant={runtimeDetail.status === 'failed' ? 'destructive' : 'secondary'} className={runtimeDetail.status !== 'failed' ? "bg-[#1a1a1a] text-zinc-400" : ""}>
                  {runtimeDetail.status}
                </Badge>
              </div>
              <div className="flex flex-col gap-1 text-sm text-zinc-400">
                <span className="flex items-center justify-between">
                  Step: <span className="text-zinc-200">{runtimeDetail.currentStep ?? 'n/a'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Signal: <span className="text-zinc-200">{runtimeDetail.controlSignal}</span>
                </span>
                <span className="flex items-center justify-between">
                  Company Scope: <span className="text-zinc-200">{runtimeDetail.companyId ?? 'unresolved'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Visibility: <span className="text-zinc-200">{runtimeDetail.scopeVisibility ?? 'unresolved'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Engine (configured): <span className="text-zinc-200">{runtimeDetail.configuredEngine ?? 'n/a'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Engine (used): <span className="text-zinc-200">{runtimeDetail.engineUsed ?? runtimeDetail.engine ?? 'n/a'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Route Intent: <span className="text-zinc-200">{runtimeDetail.routeIntent ?? 'n/a'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Rollback: <span className="text-zinc-200">{runtimeDetail.rolledBackFrom ? `${runtimeDetail.rolledBackFrom} (${runtimeDetail.rollbackReasonCode ?? 'n/a'})` : 'none'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Graph Node: <span className="text-zinc-200">{runtimeDetail.graphNode ?? 'n/a'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Graph Thread: <span className="text-zinc-200">{runtimeDetail.graphThreadId ?? 'n/a'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Latest Checkpoint: <span className="text-zinc-200">{runtimeDetail.latestCheckpoint?.node ?? 'none'} {runtimeDetail.latestCheckpoint ? ` (#${runtimeDetail.latestCheckpoint.version})` : ''}</span>
                </span>
                {runtimeDetail.graphStepHistory?.length ? (
                  <span className="text-zinc-500">
                    Step History: <span className="text-zinc-300">{runtimeDetail.graphStepHistory.join(' -> ')}</span>
                  </span>
                ) : null}
              </div>

              <div className="rounded-md border border-[#1a1a1a] bg-[#080808] p-3">
                <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Execution Plan</div>
                <div className="mt-3 space-y-2">
                  {runtimeDetail.plan?.length ? (
                    runtimeDetail.plan.map((step, index) => (
                      <div key={`${index}-${step}`} className="rounded-md border border-[#161616] bg-[#0d0d0d] px-3 py-2 text-sm text-zinc-300">
                        <span className="mr-2 text-zinc-500">{index + 1}.</span>
                        {step}
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-zinc-500">No plan steps were captured for this task.</p>
                  )}
                </div>
              </div>

              {runtimeDetail.latestSynthesis ? (
                <div className="rounded-md border border-[#1a1a1a] bg-[#080808] p-3">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Latest Synthesis</div>
                  <pre className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">
                    {runtimeDetail.latestSynthesis}
                  </pre>
                </div>
              ) : null}

              <div className="rounded-md border border-[#1a1a1a] bg-[#080808] p-3">
                <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Agent Results</div>
                <div className="mt-3 space-y-3">
                  {runtimeDetail.agentResultsHistory?.length ? (
                    runtimeDetail.agentResultsHistory.map((entry, index) => (
                      <div key={`${entry.agentKey}-${index}`} className="rounded-md border border-[#161616] bg-[#0d0d0d] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-zinc-200">{entry.agentKey}</div>
                          <Badge
                            variant={entry.status === 'failed' ? 'destructive' : 'outline'}
                            className={entry.status === 'failed' ? '' : 'border-[#222] bg-transparent text-zinc-400'}
                          >
                            {entry.status}
                          </Badge>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-zinc-300">{entry.message}</p>
                        {entry.metrics ? (
                          <p className="mt-2 text-xs text-zinc-500">
                            {typeof entry.metrics.latencyMs === 'number' ? `latency ${entry.metrics.latencyMs}ms` : 'latency n/a'}
                            {typeof entry.metrics.tokensUsed === 'number' ? ` · tokens ${entry.metrics.tokensUsed}` : ''}
                            {typeof entry.metrics.apiCalls === 'number' ? ` · api calls ${entry.metrics.apiCalls}` : ''}
                          </p>
                        ) : null}
                        {entry.error ? (
                          <div className="mt-2 rounded-md border border-[#2c1414] bg-[#180d0d] p-2 text-xs text-rose-300">
                            {entry.error.classifiedReason ?? entry.error.rawMessage ?? 'Unknown agent error'}
                          </div>
                        ) : null}
                        {entry.result ? (
                          <pre className="mt-3 overflow-x-auto rounded-md border border-[#161616] bg-[#090909] p-3 text-xs leading-6 text-zinc-400">
                            {JSON.stringify(entry.result, null, 2)}
                          </pre>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-zinc-500">No agent results captured yet.</p>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {runtimeTrace ? (
            <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-md p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between pb-3 border-b border-[#1a1a1a]">
                <strong className="text-zinc-200 text-sm font-medium">Graph Trace</strong>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent">
                    cfg: {runtimeTrace.configuredEngine ?? runtimeTrace.engine}
                  </Badge>
                  <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent">
                    run: {runtimeTrace.engineUsed ?? runtimeTrace.engine}
                  </Badge>
                </div>
              </div>
              <ScrollArea className="h-44 rounded border border-[#1a1a1a] bg-[#080808]">
                <div className="flex flex-col">
                  {runtimeTrace.transitions.map((step) => (
                    <div key={`${step.version}:${step.node}`} className="px-3 py-2 border-b border-[#141414] last:border-b-0">
                      <p className="text-sm text-zinc-200">
                        #{step.version} &middot; {step.node}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {new Date(step.updatedAt).toLocaleString()} &middot; engine: {step.engine}
                        {step.graphNode ? ` · graphNode: ${step.graphNode}` : ''}
                        {step.routeIntent ? ` · intent: ${step.routeIntent}` : ''}
                        {step.routeSource ? ` · routeSource: ${step.routeSource}` : ''}
                        {step.planSource ? ` · planSource: ${step.planSource}` : ''}
                        {step.routeFallbackReasonCode ? ` · fallback: ${step.routeFallbackReasonCode}` : ''}
                        {step.responseDeliveryStatus ? ` · delivery: ${step.responseDeliveryStatus}` : ''}
                        {step.recoveryMode ? ` · recovery: ${step.recoveryMode}` : ''}
                      </p>
                      {step.planValidationErrors?.length ? (
                        <div className="mt-2 rounded-md border border-[#241b12] bg-[#16120d] px-2 py-1.5 text-xs text-amber-300">
                          {step.planValidationErrors.join(' | ')}
                        </div>
                      ) : null}
                      {step.resumeDecisionReason ? (
                        <p className="mt-2 text-xs text-zinc-500">{step.resumeDecisionReason}</p>
                      ) : null}
                    </div>
                  ))}
                  {runtimeTrace.transitions.length === 0 ? (
                    <p className="text-xs text-zinc-500 p-3">No checkpoint history found for this task yet.</p>
                  ) : null}
                </div>
              </ScrollArea>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            {loading ? (
              <>
                {[1, 2].map((i) => (
                  <div key={i} className="flex items-center justify-between w-full p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] h-[66px]">
                    <div className="flex flex-col gap-2 w-full">
                      <Skeleton className="h-4 w-64" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <>
                {tasks.map((task) => (
                  <button
                    key={task.taskId}
                    type="button"
                    className="flex items-center justify-between w-full p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] hover:bg-[#111] hover:border-[#222] transition-colors text-left"
                    onClick={() => void inspectTask(task.taskId)}
                  >
                    <div className="flex flex-col">
                      <strong className="text-zinc-200 text-sm font-medium">{task.taskId}</strong>
                      <span className="text-xs text-zinc-500 mt-1">
                        {task.status} &middot; scope: {task.companyId ?? task.scopeVisibility ?? 'unresolved'} &middot; engine: {task.engineUsed ?? task.engine ?? 'n/a'} &middot; step: {task.currentStep ?? 'n/a'} &middot; signal: {task.controlSignal}
                      </span>
                    </div>
                  </button>
                ))}
                {tasks.length === 0 ? <p className="text-sm text-zinc-500 italic p-2 rounded bg-[#0a0a0a] border border-dashed border-[#222]">No runtime tasks found.</p> : null}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
