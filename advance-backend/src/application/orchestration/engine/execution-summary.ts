export interface ToolTraceEntry {
  readonly toolName: string;
  readonly status: 'success' | 'error';
  readonly summary: string;
  readonly children?: readonly ToolTraceEntry[];
}

const TRACE_SENTINEL = '<!--TOOL_TRACE:';
const TRACE_SENTINEL_END = '-->';
const MAX_OUTPUT_LENGTH = 800;

export function parseSubAgentTrace(output: string): ToolTraceEntry[] | null {
  const idx = output.lastIndexOf(TRACE_SENTINEL);
  if (idx === -1) return null;
  const endIdx = output.indexOf(TRACE_SENTINEL_END, idx + TRACE_SENTINEL.length);
  if (endIdx === -1) return null;
  try {
    const json = output.slice(idx + TRACE_SENTINEL.length, endIdx);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed as ToolTraceEntry[];
  } catch {
    return null;
  }
}

export function stripTraceMarker(output: string): string {
  const idx = output.lastIndexOf(TRACE_SENTINEL);
  if (idx === -1) return output;
  return output.slice(0, idx).trimEnd();
}

function truncateOutput(output: string, max: number): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function formatTraceEntry(
  entry: { toolName: string; output: string },
  index: number,
): string {
  const cleanOutput = stripTraceMarker(entry.output);
  const children = parseSubAgentTrace(entry.output);
  const summary = truncateOutput(cleanOutput, MAX_OUTPUT_LENGTH);
  const status = cleanOutput.startsWith('error:') ? 'error' : 'success';

  let line = `${index + 1}. ${entry.toolName} → ${status}: ${summary}`;

  if (children && children.length > 0) {
    const subLines = children.map((c, i) => {
      const letter = String.fromCharCode(97 + i); // a, b, c...
      return `   ${letter}. ${c.toolName} → ${c.status}: ${truncateOutput(c.summary, 300)}`;
    });
    line += '\n   Sub-steps:\n' + subLines.join('\n');
  }

  return line;
}

export function buildExecutionSummary(
  toolResults: ReadonlyArray<{ toolName: string; output: string }>,
): string | null {
  const filtered = toolResults.filter(r => r.toolName !== 'manageTodos');
  if (filtered.length === 0) return null;

  const lines = filtered.map((entry, i) => formatTraceEntry(entry, i));
  return `[Execution]\n${lines.join('\n')}`;
}
