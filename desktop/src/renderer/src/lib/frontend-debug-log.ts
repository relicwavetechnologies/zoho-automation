type FrontendDebugEntry = {
  ts: string
  scope: string
  event: string
  data?: Record<string, unknown>
}

const FRONTEND_DEBUG_LOG_KEY = 'cursorr_frontend_debug_log'
const MAX_FRONTEND_DEBUG_ENTRIES = 300

const readEntries = (): FrontendDebugEntry[] => {
  try {
    const raw = localStorage.getItem(FRONTEND_DEBUG_LOG_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as FrontendDebugEntry[] : []
  } catch {
    return []
  }
}

const writeEntries = (entries: FrontendDebugEntry[]): void => {
  try {
    localStorage.setItem(FRONTEND_DEBUG_LOG_KEY, JSON.stringify(entries.slice(-MAX_FRONTEND_DEBUG_ENTRIES)))
  } catch {
    // Never break UI for logging.
  }
}

export const appendFrontendDebugLog = (
  scope: string,
  event: string,
  data?: Record<string, unknown>,
): void => {
  const entry: FrontendDebugEntry = {
    ts: new Date().toISOString(),
    scope,
    event,
    ...(data ? { data } : {}),
  }
  try {
    const entries = readEntries()
    entries.push(entry)
    writeEntries(entries)
  } catch {
    // Never break UI for logging.
  }
  try {
    console.info(`[frontend:${scope}] ${event}`, data ?? {})
  } catch {
    // no-op
  }
}

export const clearFrontendDebugLog = (): void => {
  try {
    localStorage.removeItem(FRONTEND_DEBUG_LOG_KEY)
  } catch {
    // no-op
  }
}
