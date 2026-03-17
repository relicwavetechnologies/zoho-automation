type FrontendDebugEntry = {
  timestamp: string
  event: string
  payload?: Record<string, unknown>
}

const STORAGE_KEY = 'cursorr_frontend_debug_log'
const MAX_ENTRIES = 200

const readEntries = (): FrontendDebugEntry[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as FrontendDebugEntry[] : []
  } catch {
    return []
  }
}

const writeEntries = (entries: FrontendDebugEntry[]): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
  } catch {
    // ignore storage failures
  }
}

export const logFrontendDebug = (event: string, payload?: Record<string, unknown>): void => {
  const entry: FrontendDebugEntry = {
    timestamp: new Date().toISOString(),
    event,
    ...(payload ? { payload } : {}),
  }
  const entries = readEntries()
  entries.push(entry)
  writeEntries(entries)
  console.info('[frontend:chat]', event, payload ?? {})
}

export const logFrontendError = (event: string, error: unknown, payload?: Record<string, unknown>): void => {
  const details = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error) }
  logFrontendDebug(event, {
    ...details,
    ...(payload ?? {}),
  })
}
