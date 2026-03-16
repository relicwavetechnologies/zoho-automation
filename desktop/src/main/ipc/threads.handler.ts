import { ipcMain } from 'electron'
import { net } from 'electron'

const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'

const extractBackendErrorMessage = (bodyText: string, status: number): string => {
  if (!bodyText) return `Request failed (${status})`
  try {
    const parsed = JSON.parse(bodyText) as {
      message?: string
      details?: string
      requestId?: string
      error?: string
    }
    const parts = [
      typeof parsed.message === 'string' ? parsed.message : null,
      typeof parsed.details === 'string' ? parsed.details : null,
      typeof parsed.error === 'string' ? parsed.error : null,
      typeof parsed.requestId === 'string' ? `requestId=${parsed.requestId}` : null,
    ].filter((part): part is string => Boolean(part && part.trim().length > 0))
    return parts.length > 0 ? `${parts.join(' · ')} (HTTP ${status})` : `Request failed (${status})`
  } catch {
    return `${bodyText} (HTTP ${status})`
  }
}

const fetchJson = async (
  url: string,
  options: Parameters<typeof net.fetch>[1],
): Promise<unknown> => {
  try {
    const res = await net.fetch(url, options)
    const bodyText = await res.text()
    if (!res.ok) {
      return {
        success: false,
        message: extractBackendErrorMessage(bodyText, res.status),
      }
    }
    try {
      return bodyText ? JSON.parse(bodyText) : { success: true }
    } catch {
      return {
        success: false,
        message: `Malformed JSON response (HTTP ${res.status})`,
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Request failed',
    }
  }
}

export function registerThreadHandlers(): void {
  ipcMain.handle('desktop:threads', async (_event, token: string) => {
    return fetchJson(`${BACKEND_URL}/api/desktop/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  })

  ipcMain.handle(
    'desktop:thread',
    async (
      _event,
      token: string,
      threadId: string,
      options?: { limit?: number; beforeMessageId?: string },
    ) => {
      const params = new URLSearchParams()
      if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
        params.set('limit', String(options.limit))
      }
      if (options?.beforeMessageId) {
        params.set('beforeMessageId', options.beforeMessageId)
      }
      const query = params.toString()
      return fetchJson(`${BACKEND_URL}/api/desktop/threads/${threadId}${query ? `?${query}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    },
  )

  ipcMain.handle(
    'desktop:thread:create',
    async (_event, token: string, payload?: { preferredEngine?: 'mastra' | 'langgraph' }) => {
      return fetchJson(`${BACKEND_URL}/api/desktop/threads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
    },
  )

  ipcMain.handle(
    'desktop:thread:update-preferences',
    async (
      _event,
      token: string,
      threadId: string,
      payload: { preferredEngine: 'mastra' | 'langgraph' },
    ) => {
      return fetchJson(`${BACKEND_URL}/api/desktop/threads/${threadId}/preferences`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
  )

  ipcMain.handle(
    'desktop:thread:add-message',
    async (
      _event,
      token: string,
      threadId: string,
      payload: { role: string; content: string; metadata?: Record<string, unknown> },
    ) => {
      return fetchJson(`${BACKEND_URL}/api/desktop/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
  )

  ipcMain.handle('desktop:thread:delete', async (_event, token: string, threadId: string) => {
    const result = await fetchJson(`${BACKEND_URL}/api/desktop/threads/${threadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return { success: result.success, ...(result.message ? { message: result.message } : {}) }
  })
}
