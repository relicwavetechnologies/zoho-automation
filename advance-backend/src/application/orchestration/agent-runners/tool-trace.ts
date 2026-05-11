const TRACE_SENTINEL = '<!--TOOL_TRACE:';
const TRACE_SENTINEL_END = '-->';

interface StepLike {
  toolCalls?: readonly { toolName: string }[];
  toolResults?: readonly { toolName?: string; output?: unknown }[];
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
