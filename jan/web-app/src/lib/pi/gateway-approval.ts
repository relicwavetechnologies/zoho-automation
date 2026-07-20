export type DivoGatewayApprovalState = 'pending' | 'rejected'

export type DivoGatewayApproval = {
  state: DivoGatewayApprovalState
  approvalId?: string
  message: string
}

type ToolLikePart = {
  type?: unknown
  toolName?: unknown
  output?: unknown
  error?: unknown
  errorText?: unknown
}

const MAX_ERROR_PAYLOAD_CHARS = 32_000
const MAX_APPROVAL_ID_CHARS = 200
const MAX_APPROVAL_MESSAGE_CHARS = 1_000

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value.length > MAX_ERROR_PAYLOAD_CHARS) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function detailsFromValue(value: unknown): Record<string, unknown> | undefined {
  const parsed = asRecord(parseMaybeJson(value))
  if (!parsed) return undefined
  return asRecord(parsed.details) ?? parsed
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

export function isDivoGatewayTool(part: ToolLikePart): boolean {
  return part.type === 'tool-divo_gateway' || part.toolName === 'divo_gateway'
}

/**
 * Read only the structured HITL status emitted by Divo's backend gateway.
 *
 * Pi maps `isError` tool results into `errorText`, so check both regular tool
 * output and the error payload. Nothing is inferred from prose: the exact
 * gateway tool identity and an exact backend status are required.
 */
export function readDivoGatewayApproval(
  part: ToolLikePart
): DivoGatewayApproval | undefined {
  if (!isDivoGatewayTool(part)) return undefined

  const details = [part.output, part.error, part.errorText]
    .map(detailsFromValue)
    .find((value): value is Record<string, unknown> => Boolean(value))
  if (!details) return undefined

  const state =
    details.status === 'approval_required'
      ? 'pending'
      : details.status === 'approval_rejected'
        ? 'rejected'
        : undefined
  if (!state) return undefined

  const approval = asRecord(details.approval)
  const message =
    boundedText(approval?.message, MAX_APPROVAL_MESSAGE_CHARS) ??
    (state === 'pending'
      ? 'Manager approval is required before this action can run.'
      : 'This action was not approved.')

  return {
    state,
    approvalId: boundedText(approval?.approvalId, MAX_APPROVAL_ID_CHARS),
    message,
  }
}

/** True only for a structured backend HITL result that must stay visible in the trace. */
export function isDivoGatewayApprovalTool(part: ToolLikePart): boolean {
  return readDivoGatewayApproval(part) !== undefined
}
