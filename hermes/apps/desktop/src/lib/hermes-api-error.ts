const IPC_PREFIX = "Error invoking remote method 'hermes:api': "

function stripIpcPrefix(message: string): string {
  return message.startsWith(IPC_PREFIX) ? message.slice(IPC_PREFIX.length) : message
}

function parseStatusBody(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as { detail?: unknown; error?: unknown }
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim()
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim()
    }
  } catch {
    // fall through to raw body
  }

  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed
}

/** Turn Electron IPC / main-process fetch failures into user-facing copy. */
export function parseHermesApiIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const withoutPrefix = stripIpcPrefix(raw).replace(/^Error:\s*/, '')

  const statusMatch = /^(\d{3}):\s*([\s\S]*)$/.exec(withoutPrefix)
  if (statusMatch) {
    const [, status, body] = statusMatch
    const detail = parseStatusBody(body)
    if (detail) {
      return `HTTP ${status}: ${detail}`
    }
    return `HTTP ${status}`
  }

  return withoutPrefix.trim() || 'Failed to reach Hermes backend'
}
