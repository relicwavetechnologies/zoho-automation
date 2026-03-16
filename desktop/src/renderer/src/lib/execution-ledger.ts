import type { ContentBlock, ExecutionEventItem, ExecutionPlan, StreamEvent } from '../types'

type LedgerEvent = {
  type: StreamEvent['type'] | 'progress'
  data: unknown
  createdAtMs?: number
}

type LedgerState = {
  blocks: ContentBlock[]
  plan: ExecutionPlan | null
  activeThinkingStartedAtMs: number | null
}

const isActivityFailure = (input: { label?: string; resultSummary?: string }): boolean => {
  const label = (input.label ?? '').toLowerCase()
  const summary = (input.resultSummary ?? '').toLowerCase()
  return (
    label.includes('failed')
    || label.includes('error')
    || summary === 'error'
    || summary.includes('failed')
    || summary.includes('error:')
    || summary.includes('not permitted')
  )
}

const finalizeThinking = (state: LedgerState, endAtMs?: number): LedgerState => {
  if (state.activeThinkingStartedAtMs == null) {
    return state
  }
  const last = state.blocks[state.blocks.length - 1]
  if (!last || last.type !== 'thinking') {
    return { ...state, activeThinkingStartedAtMs: null }
  }
  const durationMs = endAtMs && endAtMs >= state.activeThinkingStartedAtMs
    ? endAtMs - state.activeThinkingStartedAtMs
    : undefined
  return {
    ...state,
    activeThinkingStartedAtMs: null,
    blocks: [
      ...state.blocks.slice(0, -1),
      { ...last, ...(durationMs ? { durationMs } : {}) },
    ],
  }
}

const appendOrMergeText = (blocks: ContentBlock[], content: string): ContentBlock[] => {
  const last = blocks[blocks.length - 1]
  if (last?.type === 'text') {
    return [...blocks.slice(0, -1), { type: 'text', content: `${last.content}${content}` }]
  }
  return [...blocks, { type: 'text', content }]
}

export const reduceLedgerState = (input: LedgerState, event: LedgerEvent): LedgerState => {
  const eventTimeMs = event.createdAtMs
  const state = event.type === 'thinking' || event.type === 'thinking_token'
    ? input
    : finalizeThinking(input, eventTimeMs)

  switch (event.type) {
    case 'thinking': {
      const last = state.blocks[state.blocks.length - 1]
      if (last?.type === 'thinking' && state.activeThinkingStartedAtMs != null) {
        return state
      }
      return {
        ...state,
        activeThinkingStartedAtMs: eventTimeMs ?? Date.now(),
        blocks: [...state.blocks, { type: 'thinking' }],
      }
    }
    case 'thinking_token': {
      const delta = String(event.data ?? '')
      if (!delta) return state
      const last = state.blocks[state.blocks.length - 1]
      if (last?.type !== 'thinking') return state
      return {
        ...state,
        blocks: [
          ...state.blocks.slice(0, -1),
          { ...last, text: `${last.text ?? ''}${delta}` },
        ],
      }
    }
    case 'activity': {
      const raw = event.data as { id?: string; name?: string; label?: string; icon?: string }
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            type: 'tool',
            id: raw.id ?? `tool-${state.blocks.length + 1}`,
            name: raw.name ?? '',
            label: raw.label ?? raw.name ?? 'Working...',
            icon: raw.icon ?? 'zap',
            status: 'running',
          },
        ],
      }
    }
    case 'activity_done': {
      const raw = event.data as { id?: string; name?: string; label?: string; icon?: string; resultSummary?: string }
      const ok = !isActivityFailure(raw)
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.type === 'tool' && block.id === raw.id
            ? {
              ...block,
              name: raw.name ?? block.name,
              label: raw.label ?? block.label,
              icon: raw.icon ?? block.icon,
              status: ok ? 'done' : 'failed',
              resultSummary: raw.resultSummary,
            }
            : block,
        ),
      }
    }
    case 'progress': {
      const raw = event.data as {
        type?: string
        skillId?: string
        workerKey?: string
        success?: boolean
        summary?: string
        reason?: string
      }
      if (raw.type === 'skill_loaded' && raw.skillId) {
        const runningIndex = [...state.blocks].reverse().findIndex((block) => block.type === 'tool' && block.status === 'running')
        if (runningIndex === -1) return state
        const targetIndex = state.blocks.length - 1 - runningIndex
        return {
          ...state,
          blocks: state.blocks.map((block, index) =>
            index === targetIndex && block.type === 'tool'
              ? { ...block, status: 'done', resultSummary: `Loaded SKILL.md for ${raw.skillId}` }
              : block,
          ),
        }
      }
      if (raw.type === 'worker_result' && raw.success === false && raw.workerKey) {
        const runningIndex = [...state.blocks].reverse().findIndex((block) => block.type === 'tool' && block.status === 'running')
        if (runningIndex === -1) return state
        const targetIndex = state.blocks.length - 1 - runningIndex
        return {
          ...state,
          blocks: state.blocks.map((block, index) =>
            index === targetIndex && block.type === 'tool'
              ? { ...block, status: 'failed', resultSummary: raw.summary ?? `${raw.workerKey} failed` }
              : block,
          ),
        }
      }
      if (raw.type === 'fail' && raw.reason) {
        return {
          ...state,
          blocks: appendOrMergeText(state.blocks, raw.reason),
        }
      }
      return state
    }
    case 'plan':
      return {
        ...state,
        plan: (event.data as ExecutionPlan | null) ?? null,
      }
    case 'text': {
      const raw = typeof event.data === 'string'
        ? event.data
        : typeof (event.data as { text?: unknown })?.text === 'string'
          ? String((event.data as { text: string }).text)
          : ''
      if (!raw) return state
      return {
        ...state,
        blocks: appendOrMergeText(state.blocks, raw),
      }
    }
    default:
      return state
  }
}

const normalizeExecutionEvent = (event: ExecutionEventItem): LedgerEvent | null => {
  const payload = event.payload ?? {}
  const streamType = typeof payload.streamType === 'string' ? payload.streamType : null
  const streamData = Object.prototype.hasOwnProperty.call(payload, 'streamData') ? payload.streamData : null
  const createdAtMs = Number.isFinite(Date.parse(event.createdAt)) ? Date.parse(event.createdAt) : undefined

  if (streamType) {
    return {
      type: streamType as LedgerEvent['type'],
      data: streamData,
      createdAtMs,
    }
  }

  if (event.eventType.startsWith('progress.')) {
    return {
      type: 'progress',
      data: payload,
      createdAtMs,
    }
  }
  if (event.eventType === 'activity.started') {
    return { type: 'activity', data: payload, createdAtMs }
  }
  if (event.eventType === 'activity.completed') {
    return { type: 'activity_done', data: payload, createdAtMs }
  }
  if (event.eventType === 'plan.snapshot') {
    return { type: 'plan', data: payload, createdAtMs }
  }
  if (event.eventType === 'text') {
    return { type: 'text', data: payload, createdAtMs }
  }
  if (event.eventType === 'thinking') {
    return { type: 'thinking', data: payload, createdAtMs }
  }
  if (event.eventType === 'thinking_token') {
    return { type: 'thinking_token', data: payload, createdAtMs }
  }
  return null
}

export const replayExecutionEvents = (events: ExecutionEventItem[]): {
  blocks: ContentBlock[]
  plan: ExecutionPlan | null
} => {
  const finalState = events.reduce<LedgerState>((state, event) => {
    const normalized = normalizeExecutionEvent(event)
    if (!normalized) return state
    return reduceLedgerState(state, normalized)
  }, {
    blocks: [],
    plan: null,
    activeThinkingStartedAtMs: null,
  })

  const finalized = finalizeThinking(finalState)
  return {
    blocks: finalized.blocks,
    plan: finalized.plan,
  }
}

export const applyLiveStreamEventToLedger = (input: {
  blocks: ContentBlock[]
  plan: ExecutionPlan | null
  activeThinkingStartedAtMs: number | null
  event: { type: string; data: unknown }
  createdAtMs?: number
}): LedgerState =>
  reduceLedgerState(
    {
      blocks: input.blocks,
      plan: input.plan,
      activeThinkingStartedAtMs: input.activeThinkingStartedAtMs,
    },
    {
      type: input.event.type as LedgerEvent['type'],
      data: input.event.data,
      createdAtMs: input.createdAtMs,
    },
  )
