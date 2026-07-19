export type DivoSubagentState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type DivoSubagentActivity = {
  kind: 'queued' | 'thinking' | 'tool' | 'waiting' | 'complete' | 'failed' | 'cancelled'
  label?: string
  toolCallId?: string
}

export type DivoSubagentEvent = {
  seq: number
  at: string
  kind: string
  label?: string
}

export type DivoSubagentChild = {
  id: string
  index: number
  role: string
  task: string
  state: DivoSubagentState
  startedAt?: string
  endedAt?: string
  activity: DivoSubagentActivity
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
    contextTokens: number
    turns: number
  }
  model?: string
  outputPreview?: string
  finalOutput?: string
  error?: string
  events: DivoSubagentEvent[]
}

export type DivoSubagentDetails = {
  version: 1
  parentToolCallId: string
  mode: 'single' | 'parallel' | 'chain'
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  summary: {
    total: number
    queued: number
    running: number
    completed: number
    failed: number
    cancelled: number
  }
  children: DivoSubagentChild[]
  updatedAt?: string
}

type ToolLikePart = {
  type?: unknown
  toolName?: unknown
  input?: unknown
  output?: unknown
  toolCallId?: unknown
}

const MAX_PREVIEW_CHARS = 1_200
const MAX_EVENT_COUNT = 24

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function truncate(value: string, max = MAX_PREVIEW_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function subagentState(value: unknown): DivoSubagentState {
  return value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : 'queued'
}

function childFromRecord(value: unknown, index: number, fallbackId: string): DivoSubagentChild {
  const record = asRecord(value) ?? {}
  const usage = asRecord(record.usage) ?? {}
  const activity = asRecord(record.activity) ?? {}
  const events = Array.isArray(record.events)
    ? record.events.slice(-MAX_EVENT_COUNT).flatMap((event, eventIndex) => {
        const item = asRecord(event)
        if (!item) return []
        return [{
          seq: number(item.seq, eventIndex + 1),
          at: string(item.at),
          kind: string(item.kind, 'update'),
          label: string(item.label) || undefined,
        }]
      })
    : []

  return {
    id: string(record.id, fallbackId),
    index: number(record.index, index),
    role: string(record.role, 'subagent'),
    task: string(record.task),
    state: subagentState(record.state),
    startedAt: string(record.startedAt) || undefined,
    endedAt: string(record.endedAt) || undefined,
    activity: {
      kind: (string(activity.kind, 'queued') as DivoSubagentActivity['kind']),
      label: string(activity.label) || undefined,
      toolCallId: string(activity.toolCallId) || undefined,
    },
    usage: {
      input: number(usage.input),
      output: number(usage.output),
      cacheRead: number(usage.cacheRead),
      cacheWrite: number(usage.cacheWrite),
      cost: number(usage.cost),
      contextTokens: number(usage.contextTokens),
      turns: number(usage.turns),
    },
    model: string(record.model) || undefined,
    outputPreview: truncate(string(record.outputPreview)) || undefined,
    finalOutput: truncate(string(record.finalOutput)) || undefined,
    error: truncate(string(record.error)) || undefined,
    events,
  }
}

function deriveSummary(children: DivoSubagentChild[]): DivoSubagentDetails['summary'] {
  const summary = {
    total: children.length,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const child of children) summary[child.state] += 1
  return summary
}

function plannedChildren(input: unknown, toolCallId: string): DivoSubagentChild[] {
  const record = asRecord(parseMaybeJson(input))
  if (!record) return []
  const tasks = Array.isArray(record.tasks)
    ? record.tasks
    : Array.isArray(record.chain)
      ? record.chain
      : record.agent && record.task
        ? [{ agent: record.agent, task: record.task }]
        : []
  return tasks.flatMap((task, index) => {
    const item = asRecord(task)
    if (!item) return []
    return [
      childFromRecord(
        { id: `${toolCallId}:planned:${index}`, role: item.agent, task: item.task },
        index,
        `${toolCallId}:planned:${index}`
      ),
    ]
  })
}

function detailsFromOutput(output: unknown): Record<string, unknown> | undefined {
  const parsed = asRecord(parseMaybeJson(output))
  if (!parsed) return undefined
  return asRecord(parsed.details) ?? parsed
}

export function isDivoSubagentTool(part: ToolLikePart): boolean {
  return part.type === 'tool-divo_subagents' || part.toolName === 'divo_subagents'
}

/**
 * Normalizes the custom tool's latest snapshot. It deliberately falls back to
 * the original tool input while Pi is still spawning children, so every card is
 * visible in its owning parent run from the first tool event onward.
 */
export function readDivoSubagentDetails(part: ToolLikePart): DivoSubagentDetails {
  const toolCallId = string(part.toolCallId, 'subagent-tool')
  const raw = detailsFromOutput(part.output)
  const rawChildren = Array.isArray(raw?.children) ? raw.children : undefined
  const children = rawChildren
    ? rawChildren.map((child, index) => childFromRecord(child, index, `${toolCallId}:${index}`))
    : plannedChildren(part.input, toolCallId)
  const summary = deriveSummary(children)
  const rawState = string(raw?.state)
  const state =
    rawState === 'completed' || rawState === 'failed' || rawState === 'cancelled'
      ? rawState
      : summary.queued + summary.running > 0
        ? 'running'
        : summary.failed > 0
          ? 'failed'
          : summary.cancelled === summary.total && summary.total > 0
            ? 'cancelled'
            : 'completed'

  return {
    version: 1,
    parentToolCallId: string(raw?.parentToolCallId, toolCallId),
    mode:
      raw?.mode === 'parallel' || raw?.mode === 'chain'
        ? raw.mode
        : Array.isArray(asRecord(parseMaybeJson(part.input))?.tasks)
          ? 'parallel'
          : Array.isArray(asRecord(parseMaybeJson(part.input))?.chain)
            ? 'chain'
            : 'single',
    state,
    summary,
    children: children.sort((left, right) => left.index - right.index),
    updatedAt: string(raw?.updatedAt) || undefined,
  }
}
