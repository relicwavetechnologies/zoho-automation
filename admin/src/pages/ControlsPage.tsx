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
  status: string;
  currentStep?: string;
  controlSignal: 'running' | 'paused' | 'cancelled';
  engine?: 'legacy' | 'langgraph';
  graphThreadId?: string;
  graphNode?: string;
  graphStepHistory?: string[];
  routeIntent?: string;
  updatedAt: string;
};

type RuntimeTaskDetail = RuntimeTask & {
  latestCheckpoint?: {
    version: number;
    node: string;
    updatedAt: string;
  } | null;
};

type RuntimeTaskTrace = {
  taskId: string;
  engine: 'legacy' | 'langgraph';
  graphThreadId?: string;
  latestNode?: string | null;
  transitions: Array<{
    version: number;
    node: string;
    updatedAt: string;
    engine: 'legacy' | 'langgraph';
    graphNode?: string;
    graphThreadId?: string;
  }>;
};

export const ControlsPage = () => {
  const { token, session } = useAdminAuth();
  const [rows, setRows] = useState<ControlState[]>([]);
  const [tasks, setTasks] = useState<RuntimeTask[]>([]);
  const [runtimeTaskId, setRuntimeTaskId] = useState('');
  const [runtimeAction, setRuntimeAction] = useState<'pause' | 'resume' | 'cancel'>('pause');
  const [runtimeDetail, setRuntimeDetail] = useState<RuntimeTaskDetail | null>(null);
  const [runtimeTrace, setRuntimeTrace] = useState<RuntimeTaskTrace | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!token) return;
    try {
      setLoading(true);
      const [result, runtime] = await Promise.all([
        api.get<ControlState[]>('/api/admin/controls', token),
        api.get<RuntimeTask[]>('/api/admin/runtime/tasks?limit=20', token),
      ]);
      setRows(result);
      setTasks(runtime);
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
            <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-md p-4 flex flex-col gap-3">
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
                  Engine: <span className="text-zinc-200">{runtimeDetail.engine ?? 'n/a'}</span>
                </span>
                <span className="flex items-center justify-between">
                  Route Intent: <span className="text-zinc-200">{runtimeDetail.routeIntent ?? 'n/a'}</span>
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
            </div>
          ) : null}

          {runtimeTrace ? (
            <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-md p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between pb-3 border-b border-[#1a1a1a]">
                <strong className="text-zinc-200 text-sm font-medium">Graph Trace</strong>
                <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent">
                  {runtimeTrace.engine}
                </Badge>
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
                      </p>
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
                        {task.status} &middot; engine: {task.engine ?? 'n/a'} &middot; step: {task.currentStep ?? 'n/a'} &middot; signal: {task.controlSignal}
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
