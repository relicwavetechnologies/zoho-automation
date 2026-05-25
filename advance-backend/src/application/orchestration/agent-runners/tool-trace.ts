import type { OrchestrationTracer } from '../../observability/orchestration-tracer';

const TRACE_SENTINEL = '<!--TOOL_TRACE:';
const TRACE_SENTINEL_END = '-->';

interface ToolCallLike {
  toolName: string;
}

interface ToolResultLike {
  toolName?: string;
  output?: unknown;
  result?: unknown;
}

interface StepLike {
  toolCalls?: readonly ToolCallLike[];
  toolResults?: readonly ToolResultLike[];
  dynamicToolResults?: readonly ToolResultLike[];
  staticToolResults?: readonly ToolResultLike[];
}

export function appendToolTrace(text: string, steps: readonly StepLike[] | undefined): string {
  if (!steps || steps.length === 0) return text;

  const entries: { toolName: string; status: string; summary: string }[] = [];
  for (const step of steps) {
    for (let i = 0; i < (step.toolCalls?.length ?? 0); i++) {
      const tc = step.toolCalls![i]!;
      const tr = step.toolResults?.[i];
      const output = tr?.output != null ? String(tr.output) : '';
      entries.push({
        toolName: tc.toolName,
        status: output.startsWith('error:') ? 'error' : 'success',
        summary: output.slice(0, 300),
      });
    }
  }

  if (entries.length === 0) return text;
  return `${text}\n${TRACE_SENTINEL}${JSON.stringify(entries)}${TRACE_SENTINEL_END}`;
}

export function isErrorOutput(output: string): boolean {
  return output.startsWith('error:');
}

export function buildToolFinishedPayload(
  toolName: string,
  output: string,
  startMs?: number,
): {
  toolName: string;
  resultLength: number;
  resultPreview: string;
  durationMs?: number;
  error?: string;
} {
  const isError = isErrorOutput(output);
  return {
    toolName,
    resultLength: output.length,
    resultPreview: output.slice(0, 500),
    ...(startMs !== undefined ? { durationMs: Date.now() - startMs } : {}),
    ...(isError ? { error: output.slice(0, 300) } : {}),
  };
}

export function emitSpecialistStarted(input: {
  tracer: OrchestrationTracer | undefined;
  actorKey: string;
  toolName: string;
  task: string;
  toolCount: number;
  depth?: number;
}): void {
  input.tracer?.emit({
    phase: 'execute', eventType: 'tool_call_started',
    actorType: 'specialist', actorKey: input.actorKey,
    title: `Calling ${input.actorKey}`,
    status: 'info',
    payload: {
      toolName: input.toolName,
      args: {
        task: input.task.slice(0, 500),
        toolCount: input.toolCount,
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
      },
    },
  });
}

export function emitSpecialistFinished(input: {
  tracer: OrchestrationTracer | undefined;
  actorKey: string;
  toolName: string;
  output: string;
  startMs?: number;
}): void {
  const isError = isErrorOutput(input.output);
  input.tracer?.emit({
    phase: 'execute', eventType: 'tool_call_finished',
    actorType: 'specialist', actorKey: input.actorKey,
    title: `${input.actorKey} ${isError ? 'failed' : 'completed'}`,
    status: isError ? 'error' : 'success',
    payload: buildToolFinishedPayload(input.toolName, input.output, input.startMs),
  });
}

export function emitSpecialistStepToolResults(input: {
  tracer: OrchestrationTracer | undefined;
  actorKey: string;
  steps: readonly StepLike[] | undefined;
}): void {
  if (!input.tracer || !input.steps) return;

  for (const step of input.steps) {
    const results = step.toolResults ?? [
      ...(step.dynamicToolResults ?? []),
      ...(step.staticToolResults ?? []),
    ];
    const calls = step.toolCalls ?? [];

    for (let i = 0; i < Math.max(calls.length, results.length); i++) {
      const call = calls[i];
      const result = results[i];
      const toolName = result?.toolName ?? call?.toolName;
      if (!toolName) continue;

      const rawOutput = result?.output ?? result?.result ?? '';
      const output = String(rawOutput);
      const isError = isErrorOutput(output);
      input.tracer.emit({
        phase: 'execute', eventType: 'tool_call_finished',
        actorType: 'specialist', actorKey: `${input.actorKey}/${toolName}`,
        title: `${toolName} ${isError ? 'failed' : 'completed'}`,
        status: isError ? 'error' : 'success',
        payload: buildToolFinishedPayload(toolName, output),
      });
    }
  }
}
