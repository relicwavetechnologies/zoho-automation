import type { PiRawEvent } from './types'

export const PI_MEMORY_REVIEW_REQUEST_TITLE = 'divo_memory_review_v1'
export const PI_MEMORY_REVIEW_MAX_BULLETS = 10
export const PI_MEMORY_REVIEW_MAX_BULLET_LENGTH = 500
export const PI_MEMORY_REVIEW_MAX_REVISION_LENGTH = 1_000

const MAX_MESSAGE_LENGTH = 16_000
const MAX_FIELD_LENGTH = 200

export type PiMemoryScope = 'personal' | 'department' | 'company'

export type PiMemoryReviewTarget = {
  scope: PiMemoryScope
  label: string
  departmentId?: string
}

export type PiMemoryReviewBullet = {
  id: string
  text: string
}

export type PiMemoryReviewDescriptor = {
  version: 1
  proposalId: string
  bullets: PiMemoryReviewBullet[]
  allowedTargets: PiMemoryReviewTarget[]
}

export type PiMemoryReviewRequest = {
  protocol: 'memory-review'
  requestId: string
  threadId: string
  runId: string
  descriptor: PiMemoryReviewDescriptor
  status: 'pending' | 'submitting' | 'error'
  error?: string
}

export type PiMemoryReviewResponse = {
  version: 1
  proposalId: string
  decision: 'approve' | 'revise' | 'cancel'
  selectedTarget: { scope: PiMemoryScope; departmentId?: string } | null
  selectedBulletIds: string[]
  revision?: string
}

export type PiMemoryReviewParseResult =
  | { kind: 'not-memory-review' }
  | {
      kind: 'invalid'
      requestId?: string
      threadId?: string
      runId?: string
      reason: string
    }
  | { kind: 'memory-review'; request: PiMemoryReviewRequest }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function boundedString(value: unknown, field: string, max = MAX_FIELD_LENGTH) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  const result = value.trim()
  if (result.length > max) throw new Error(`${field} is too long`)
  return result
}

export function memoryReviewTargetKey(
  target: Pick<PiMemoryReviewTarget, 'scope' | 'departmentId'>
) {
  return `${target.scope}:${target.departmentId ?? ''}`
}

function parseDescriptor(prefill: string): PiMemoryReviewDescriptor {
  if (prefill.length > MAX_MESSAGE_LENGTH) {
    throw new Error('memory review request is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(prefill)
  } catch {
    throw new Error('memory review request is not valid JSON')
  }
  const descriptor = record(parsed)
  if (!descriptor || descriptor.version !== 1) {
    throw new Error('unsupported memory review protocol version')
  }
  const proposalId = boundedString(descriptor.proposalId, 'proposalId')

  if (
    !Array.isArray(descriptor.bullets) ||
    descriptor.bullets.length > PI_MEMORY_REVIEW_MAX_BULLETS
  ) {
    throw new Error('memory review bullets must be a bounded array')
  }
  const bulletIds = new Set<string>()
  const bullets = descriptor.bullets.map((value, index) => {
    const bullet = record(value)
    if (!bullet) throw new Error(`bullets[${index}] must be an object`)
    const id = boundedString(bullet.id, `bullets[${index}].id`)
    if (bulletIds.has(id)) throw new Error('memory bullet ids must be unique')
    bulletIds.add(id)
    return {
      id,
      text: boundedString(
        bullet.text,
        `bullets[${index}].text`,
        PI_MEMORY_REVIEW_MAX_BULLET_LENGTH
      ),
    }
  })

  if (
    !Array.isArray(descriptor.allowedTargets) ||
    descriptor.allowedTargets.length < 1 ||
    descriptor.allowedTargets.length > 3
  ) {
    throw new Error('memory review must contain one to three allowed targets')
  }
  const targetKeys = new Set<string>()
  const allowedTargets = descriptor.allowedTargets.map((value, index) => {
    const target = record(value)
    if (!target) {
      throw new Error(`allowedTargets[${index}] must be an object`)
    }
    const scope = target.scope
    if (scope !== 'personal' && scope !== 'department' && scope !== 'company') {
      throw new Error(`allowedTargets[${index}].scope is unsupported`)
    }
    const departmentId =
      target.departmentId === undefined
        ? undefined
        : boundedString(
            target.departmentId,
            `allowedTargets[${index}].departmentId`
          )
    if (scope === 'department' && !departmentId) {
      throw new Error('department targets require departmentId')
    }
    if (scope !== 'department' && departmentId) {
      throw new Error('only department targets may include departmentId')
    }
    const result: PiMemoryReviewTarget = {
      scope,
      label: boundedString(target.label, `allowedTargets[${index}].label`),
      ...(departmentId ? { departmentId } : {}),
    }
    const key = memoryReviewTargetKey(result)
    if (targetKeys.has(key)) throw new Error('memory review targets must be unique')
    targetKeys.add(key)
    return result
  })

  return { version: 1, proposalId, bullets, allowedTargets }
}

export function parsePiMemoryReviewEvent(
  event: PiRawEvent
): PiMemoryReviewParseResult {
  if (
    event.type !== 'extension_ui_request' ||
    event.method !== 'editor' ||
    event.title !== PI_MEMORY_REVIEW_REQUEST_TITLE
  ) {
    return { kind: 'not-memory-review' }
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
      reason: 'memory review is missing its request, thread, or run identifier',
    }
  }
  if (typeof event.prefill !== 'string') {
    return {
      kind: 'invalid',
      requestId,
      threadId,
      runId,
      reason: 'memory review is missing its structured request',
    }
  }
  try {
    return {
      kind: 'memory-review',
      request: {
        protocol: 'memory-review',
        requestId,
        threadId,
        runId,
        descriptor: parseDescriptor(event.prefill),
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

export function validatePiMemoryReviewResponse(
  request: PiMemoryReviewRequest,
  response: PiMemoryReviewResponse
): PiMemoryReviewResponse {
  if (response.version !== 1 || response.proposalId !== request.descriptor.proposalId) {
    throw new Error('memory review response does not match its proposal')
  }
  if (!['approve', 'revise', 'cancel'].includes(response.decision)) {
    throw new Error('memory review decision is invalid')
  }
  if (!Array.isArray(response.selectedBulletIds)) {
    throw new Error('selectedBulletIds must be an array')
  }
  const availableIds = new Set(request.descriptor.bullets.map((bullet) => bullet.id))
  if (
    new Set(response.selectedBulletIds).size !== response.selectedBulletIds.length ||
    response.selectedBulletIds.some((id) => !availableIds.has(id))
  ) {
    throw new Error('selected bullets are not part of this proposal')
  }
  if (
    response.selectedTarget &&
    !request.descriptor.allowedTargets.some(
      (target) =>
        memoryReviewTargetKey(target) === memoryReviewTargetKey(response.selectedTarget!)
    )
  ) {
    throw new Error('selected target was not provided by the backend')
  }
  if (
    response.decision === 'approve' &&
    (!response.selectedTarget || response.selectedBulletIds.length === 0)
  ) {
    throw new Error('approval requires a target and at least one memory')
  }
  if (
    response.decision === 'revise' &&
    (typeof response.revision !== 'string' ||
      !response.revision.trim() ||
      response.revision.trim().length > PI_MEMORY_REVIEW_MAX_REVISION_LENGTH)
  ) {
    throw new Error('revision decision requires bounded revision text')
  }
  return response
}

export function isPiMemoryReviewRequest(
  request: unknown
): request is PiMemoryReviewRequest {
  return record(request)?.protocol === 'memory-review'
}
