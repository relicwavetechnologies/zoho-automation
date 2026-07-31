import type { UIMessage } from 'ai'
import type { ThreadMessage } from '@janhq/core'
import { computeActivePath } from '@/lib/message-branching'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'

export type DivoTodoStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled'

export type DivoTodoItem = {
  id: string
  content: string
  description?: string
  activeForm?: string
  status: DivoTodoStatus
  blockedBy: string[]
  createdAt?: string
  updatedAt?: string
}

export type DivoTodoDetails = {
  version: 1
  boardId: string
  revision: number
  items: DivoTodoItem[]
  updatedAt?: string
}

type ToolLikePart = {
  type?: unknown
  toolName?: unknown
  output?: unknown
}

const MAX_ITEMS = 64
const MAX_TEXT_CHARS = 1_200
const MAX_ID_CHARS = 160
const MAX_BLOCKERS = 24

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

function text(value: unknown, max = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function status(value: unknown): DivoTodoStatus | undefined {
  return value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'blocked' ||
    value === 'cancelled'
    ? value
    : undefined
}

function detailsFromOutput(output: unknown): Record<string, unknown> | undefined {
  const parsed = asRecord(parseMaybeJson(output))
  if (!parsed) return undefined
  return asRecord(parsed.details) ?? parsed
}

function itemFromRecord(value: unknown): DivoTodoItem | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const id = text(record.id, MAX_ID_CHARS)
  const content = text(record.content)
  const itemStatus = status(record.status)
  if (!id || !content || !itemStatus) return undefined

  const blockedBy = Array.isArray(record.blockedBy)
    ? record.blockedBy
        .slice(0, MAX_BLOCKERS)
        .flatMap((item) => {
          const blocker = text(item, MAX_ID_CHARS)
          return blocker ? [blocker] : []
        })
    : []

  return {
    id,
    content,
    description: text(record.description),
    activeForm: text(record.activeForm, 240),
    status: itemStatus,
    blockedBy,
    createdAt: text(record.createdAt, 80),
    updatedAt: text(record.updatedAt, 80),
  }
}

function detailsFromRecord(value: unknown): DivoTodoDetails | undefined {
  const record = asRecord(value)
  if (!record || record.version !== 1) return undefined
  const boardId = text(record.boardId, MAX_ID_CHARS)
  const revision = record.revision
  if (
    !boardId ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0
  ) return undefined

  const seenIds = new Set<string>()
  const items = Array.isArray(record.items)
    ? record.items.slice(0, MAX_ITEMS).flatMap((item) => {
        const normalized = itemFromRecord(item)
        if (!normalized || seenIds.has(normalized.id)) return []
        seenIds.add(normalized.id)
        return [normalized]
      })
    : []

  return {
    version: 1,
    boardId,
    revision,
    items,
    updatedAt: text(record.updatedAt, 80),
  }
}

export function isDivoTodoTool(part: ToolLikePart): boolean {
  return part.type === 'tool-divo_todos' || part.toolName === 'divo_todos'
}

/** Parse only validated, bounded snapshots emitted by the Pi-owned todo tool. */
export function readDivoTodoDetails(part: ToolLikePart): DivoTodoDetails | undefined {
  if (!isDivoTodoTool(part)) return undefined
  return detailsFromRecord(detailsFromOutput(part.output))
}

/**
 * Returns the current board for one visible thread branch. A stale lower
 * revision for the same board is ignored even if an event happens to arrive
 * after a newer snapshot; a later board deliberately replaces an old board.
 */
export function latestDivoTodoDetails(messages: UIMessage[]): DivoTodoDetails | undefined {
  let latest: DivoTodoDetails | undefined
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts as ToolLikePart[]) {
      const next = readDivoTodoDetails(part)
      if (!next) continue
      if (latest?.boardId === next.boardId && next.revision < latest.revision) continue
      latest = next
    }
  }
  return latest
}

/** Resolve through the thread's active branch before looking at Pi tool state. */
export function latestDivoTodoDetailsForThread(
  messages: ThreadMessage[],
  activeRootId?: string
): DivoTodoDetails | undefined {
  return latestDivoTodoDetails(
    convertThreadMessagesToUIMessages(computeActivePath(messages, activeRootId))
  )
}

export function currentDivoTodoItem(details: DivoTodoDetails): DivoTodoItem | undefined {
  return details.items.find((item) => item.status === 'in_progress') ??
    details.items.find((item) => item.status === 'pending') ??
    details.items.find((item) => item.status === 'blocked')
}
