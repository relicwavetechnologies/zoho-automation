import type { UIMessage } from 'ai'
import type { ThreadMessage } from '@janhq/core'
import { computeActivePath } from '@/lib/message-branching'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'

export type DivoArtifactMime = 'text/markdown'

/** v2 badge details — path only; content is loaded from disk by the UI. */
export type DivoArtifactDetails = {
  version: 2
  artifactId: string
  title: string
  mime: DivoArtifactMime
  path: string
  summaryForChat?: string
  updatedAt?: string
}

type ToolLikePart = {
  type?: unknown
  toolName?: unknown
  input?: unknown
  output?: unknown
  state?: unknown
}

const MAX_TITLE = 160
const MAX_PATH = 1_200
const MAX_SUMMARY = 800
const MAX_ID = 120

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

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function detailsFromOutput(output: unknown): Record<string, unknown> | undefined {
  const parsed = asRecord(parseMaybeJson(output))
  if (!parsed) return undefined
  return asRecord(parsed.details) ?? parsed
}

function detailsFromRecord(
  record: Record<string, unknown> | undefined
): DivoArtifactDetails | undefined {
  if (!record) return undefined
  if (typeof record.error === 'string') return undefined
  // Accept v2 only. Legacy v1 (embedded content) is ignored so we never
  // treat a full-body publish as a path badge.
  if (record.version !== 2) return undefined

  const artifactId = text(record.artifactId, MAX_ID)
  const title = text(record.title, MAX_TITLE)
  const path = text(record.path, MAX_PATH)
  const mime = record.mime === 'text/markdown' ? record.mime : undefined

  if (!artifactId || !title || !path || !mime) return undefined

  return {
    version: 2,
    artifactId,
    title,
    mime,
    path,
    summaryForChat: text(record.summaryForChat, MAX_SUMMARY),
    updatedAt: text(record.updatedAt, 80),
  }
}

export function isDivoArtifactTool(part: ToolLikePart): boolean {
  return (
    part.type === 'tool-divo_artifact' || part.toolName === 'divo_artifact'
  )
}

/** Parse only validated path-badge snapshots from the Pi artifact tool. */
export function readDivoArtifactDetails(
  part: ToolLikePart
): DivoArtifactDetails | undefined {
  if (!isDivoArtifactTool(part)) return undefined
  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return undefined
  }
  return detailsFromRecord(detailsFromOutput(part.output))
}

function preferNewer(
  current: DivoArtifactDetails | undefined,
  next: DivoArtifactDetails
): DivoArtifactDetails {
  if (!current) return next
  if (
    current.updatedAt &&
    next.updatedAt &&
    next.updatedAt < current.updatedAt
  ) {
    return current
  }
  return next
}

/**
 * Artifacts published in a single assistant message, deduped by artifactId
 * (newer updatedAt wins). Order is first-seen in the message parts.
 */
export function listDivoArtifactDetails(
  message: UIMessage
): DivoArtifactDetails[] {
  if (message.role !== 'assistant') return []
  const byId = new Map<string, DivoArtifactDetails>()
  const order: string[] = []

  for (const part of message.parts as ToolLikePart[]) {
    const next = readDivoArtifactDetails(part)
    if (!next) continue
    if (!byId.has(next.artifactId)) order.push(next.artifactId)
    byId.set(next.artifactId, preferNewer(byId.get(next.artifactId), next))
  }

  return order
    .map((id) => byId.get(id))
    .filter((item): item is DivoArtifactDetails => Boolean(item))
}

/**
 * Whether this message already had an earlier badge for the same path/id
 * (used to label chips Created vs Updated).
 */
export function isArtifactUpdateInMessage(
  message: UIMessage,
  details: DivoArtifactDetails
): boolean {
  if (message.role !== 'assistant') return false
  let seen = 0
  for (const part of message.parts as ToolLikePart[]) {
    const next = readDivoArtifactDetails(part)
    if (!next) continue
    if (
      next.artifactId === details.artifactId ||
      pathsEqual(next.path, details.path)
    ) {
      seen += 1
      if (seen > 1) return true
    }
  }
  return false
}

export function latestDivoArtifactDetails(
  messages: UIMessage[]
): DivoArtifactDetails | undefined {
  let latest: DivoArtifactDetails | undefined
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts as ToolLikePart[]) {
      const next = readDivoArtifactDetails(part)
      if (!next) continue
      if (latest && latest.artifactId === next.artifactId) {
        latest = preferNewer(latest, next)
      } else {
        latest = next
      }
    }
  }
  return latest
}

export function latestDivoArtifactDetailsForThread(
  messages: ThreadMessage[],
  activeRootId?: string
): DivoArtifactDetails | undefined {
  return latestDivoArtifactDetails(
    convertThreadMessagesToUIMessages(computeActivePath(messages, activeRootId))
  )
}

export function artifactOpenKey(details: DivoArtifactDetails): string {
  return `${details.artifactId}:${details.updatedAt ?? details.path}`
}

export function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const left = norm(a)
  const right = norm(b)
  if (left === right) return true
  // Relative vs absolute: match when one path ends with the other.
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

/** Extract a file path from a completed write/edit tool part input. */
export function readFileToolPath(part: ToolLikePart): string | undefined {
  const type = typeof part.type === 'string' ? part.type : ''
  const name =
    typeof part.toolName === 'string' ? part.toolName : type.replace(/^tool-/, '')
  if (name !== 'write' && name !== 'edit') return undefined
  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return undefined
  }
  const input = asRecord(parseMaybeJson(part.input))
  return text(input?.path ?? input?.file_path, MAX_PATH)
}

export function listCompletedFileToolPaths(messages: UIMessage[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts as ToolLikePart[]) {
      const path = readFileToolPath(part)
      if (!path) continue
      const key = path.replace(/\\/g, '/').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      paths.push(path)
    }
  }
  return paths
}

export function basenamePath(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const parts = norm.split('/')
  return parts[parts.length - 1] || path
}
