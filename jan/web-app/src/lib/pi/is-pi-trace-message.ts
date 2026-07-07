import { PI_TRACE_TIMELINE_METADATA_KEY } from './constants'

export function isPiTraceMessage(
  metadata: Record<string, unknown> | undefined
): boolean {
  return metadata?.[PI_TRACE_TIMELINE_METADATA_KEY] === true
}
