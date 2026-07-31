import type { PiRawEvent } from './types'

export const PI_APPROVAL_REQUEST_TITLE = 'divo_approval_v1'
export const PI_APPROVAL_DEFAULT_TTL_MS = 10 * 60 * 1000

const MAX_MESSAGE_LENGTH = 200_000
const MAX_FIELD_LENGTH = 2_000

export type PiApprovalPresentation = Record<string, unknown>
export type PiApprovalSource = 'divo' | 'bash' | 'edit' | 'write'

export type PiRunCorrelation = {
  version: 1
  threadId: string
  runId: string
}

export type PiApprovalDescriptor = {
  version: 1
  toolCallId: string
  source: PiApprovalSource
  kind: string
  action: string
  title: string
  presentation: PiApprovalPresentation
  runCorrelation: PiRunCorrelation
  expiresAt?: string
}

export type PiApprovalRequest = {
  requestId: string
  threadId: string
  runId: string
  descriptor: PiApprovalDescriptor
  receivedAt: number
  expiresAt: number
  status: 'pending' | 'submitting' | 'error'
  error?: string
}

export type PiApprovalParseResult =
  | { kind: 'not-approval' }
  | {
      kind: 'invalid'
      requestId?: string
      threadId?: string
      runId?: string
      reason: string
    }
  | { kind: 'approval'; request: PiApprovalRequest }

function nonEmptyString(
  value: unknown,
  field: string,
  maxLength = MAX_FIELD_LENGTH
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new Error(`${field} is too long`)
  }
  return trimmed
}

function parseDescriptor(message: string): PiApprovalDescriptor {
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error('approval message is too large')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    throw new Error('approval message is not valid JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('approval message must be an object')
  }

  const record = parsed as Record<string, unknown>
  if (record.version !== 1) {
    throw new Error('unsupported approval protocol version')
  }
  const presentation = record.presentation
  if (
    !presentation ||
    typeof presentation !== 'object' ||
    Array.isArray(presentation)
  ) {
    throw new Error('presentation must be an object')
  }

  const expiresAt = record.expiresAt
  if (expiresAt !== undefined && typeof expiresAt !== 'string') {
    throw new Error('expiresAt must be an ISO timestamp')
  }

  const source = nonEmptyString(record.source, 'source', 100)
  if (!['divo', 'bash', 'edit', 'write'].includes(source)) {
    throw new Error('unsupported approval source')
  }

  const correlation = record.runCorrelation
  if (!correlation || typeof correlation !== 'object' || Array.isArray(correlation)) {
    throw new Error('approval request is missing run correlation')
  }
  const correlationRecord = correlation as Record<string, unknown>
  if (correlationRecord.version !== 1) {
    throw new Error('approval request has unsupported run correlation version')
  }

  return {
    version: 1,
    toolCallId: nonEmptyString(record.toolCallId, 'toolCallId'),
    source: source as PiApprovalSource,
    kind: nonEmptyString(record.kind, 'kind', 200),
    action: nonEmptyString(record.action, 'action', 100),
    title: nonEmptyString(record.title, 'title'),
    presentation: presentation as PiApprovalPresentation,
    runCorrelation: {
      version: 1,
      threadId: nonEmptyString(correlationRecord.threadId, 'runCorrelation.threadId'),
      runId: nonEmptyString(correlationRecord.runId, 'runCorrelation.runId'),
    },
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

/**
 * Parse only the private Divo approval protocol. Other Pi extension UI requests
 * remain available to future UI handlers and are deliberately ignored here.
 */
export function parsePiApprovalEvent(
  event: PiRawEvent,
  now = Date.now()
): PiApprovalParseResult {
  if (
    event.type !== 'extension_ui_request' ||
    event.method !== 'confirm' ||
    event.title !== PI_APPROVAL_REQUEST_TITLE
  ) {
    return { kind: 'not-approval' }
  }

  const requestId =
    typeof event.id === 'string' && event.id.trim() ? event.id.trim() : undefined
  const threadId =
    typeof event.thread_id === 'string' && event.thread_id.trim()
      ? event.thread_id.trim()
      : undefined
  const runId =
    typeof event.run_id === 'string' && event.run_id.trim()
      ? event.run_id.trim()
      : undefined

  if (!requestId || !threadId || !runId) {
    return {
      kind: 'invalid',
      requestId,
      threadId,
      runId,
      reason: 'approval request is missing its request, thread, or run identifier',
    }
  }

  if (typeof event.message !== 'string') {
    return {
      kind: 'invalid',
      requestId,
      threadId,
      runId,
      reason: 'approval request is missing its structured message',
    }
  }

  try {
    const descriptor = parseDescriptor(event.message)
    if (
      descriptor.runCorrelation.threadId !== threadId ||
      descriptor.runCorrelation.runId !== runId
    ) {
      throw new Error('approval request run correlation does not match its event owner')
    }
    const explicitExpiry = descriptor.expiresAt
      ? Date.parse(descriptor.expiresAt)
      : undefined
    if (explicitExpiry !== undefined && !Number.isFinite(explicitExpiry)) {
      throw new Error('expiresAt must be a valid ISO timestamp')
    }
    const expiresAt = explicitExpiry ?? now + PI_APPROVAL_DEFAULT_TTL_MS

    if (expiresAt <= now) {
      return {
        kind: 'invalid',
        requestId,
        threadId,
        runId,
        reason: 'approval request has expired',
      }
    }

    return {
      kind: 'approval',
      request: {
        requestId,
        threadId,
        runId,
        descriptor,
        receivedAt: now,
        expiresAt,
        status: 'pending',
      },
    }
  } catch (error) {
    return {
      kind: 'invalid',
      requestId,
      threadId,
      runId,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
