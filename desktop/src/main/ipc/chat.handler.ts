import { ipcMain } from 'electron'
import { net } from 'electron'

const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'
const activeStreamControllers = new Map<string, AbortController>()

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

async function startDesktopSseStream(input: {
  target: Electron.WebContents
  requestId: string
  url: string
  token: string
  payload: Record<string, unknown>
}): Promise<{ success: boolean; stopped?: boolean; error?: string }> {
  const controller = new AbortController()
  activeStreamControllers.set(input.requestId, controller)

  let res: Awaited<ReturnType<typeof net.fetch>>
  try {
    res = await net.fetch(input.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    })
  } catch (error) {
    activeStreamControllers.delete(input.requestId)
    if (controller.signal.aborted) {
      return { success: true, stopped: true }
    }
    const message = error instanceof Error ? error.message : 'Chat stream failed'
    input.target.send('desktop:chat:event', {
      requestId: input.requestId,
      event: {
        type: 'error',
        data: message,
      },
    })
    return { success: false, error: message }
  }

  if (!res.ok || !res.body) {
    activeStreamControllers.delete(input.requestId)
    const bodyText = await res.text()
    const error = extractBackendErrorMessage(bodyText, res.status)
    input.target.send('desktop:chat:event', {
      requestId: input.requestId,
      event: {
        type: 'error',
        data: error,
      },
    })
    return { success: false, error }
  }

  ;(async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''

        for (const frame of frames) {
          const dataLines = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))

          if (dataLines.length === 0) continue
          const raw = dataLines.join('\n').trim()
          if (!raw) continue

          try {
            const parsed = JSON.parse(raw) as { type: string; data: unknown }
            input.target.send('desktop:chat:event', { requestId: input.requestId, event: parsed })
          } catch {
            input.target.send('desktop:chat:event', {
              requestId: input.requestId,
              event: { type: 'error', data: 'Malformed stream event received from backend' },
            })
          }
        }
      }

      const trailing = buffer.trim()
      if (trailing.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(trailing.slice(6).trim()) as { type: string; data: unknown }
          input.target.send('desktop:chat:event', { requestId: input.requestId, event: parsed })
        } catch {
          // ignore final malformed fragment
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      input.target.send('desktop:chat:event', {
        requestId: input.requestId,
        event: {
          type: 'error',
          data: error instanceof Error ? error.message : 'Desktop stream failed',
        },
      })
    } finally {
      activeStreamControllers.delete(input.requestId)
    }
  })()

  return { success: true }
}

export function registerChatHandlers(): void {
  ipcMain.handle(
    'desktop:chat:send',
    async (_event, token: string, threadId: string, message: string) => {
      return fetchJson(`${BACKEND_URL}/api/desktop/chat/${threadId}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    },
  )

  ipcMain.handle(
    'desktop:chat:act',
    async (_event, token: string, threadId: string, payload: Record<string, unknown>) => {
      return fetchJson(`${BACKEND_URL}/api/desktop/chat/${threadId}/act`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
  )

  ipcMain.handle(
    'desktop:chat:share',
    async (_event, token: string, threadId: string, reason?: string) => {
      return fetchJson(`${BACKEND_URL}/api/desktop/chat/${threadId}/share`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reason ? { reason } : {}),
      })
    },
  )

  ipcMain.handle(
    'desktop:chat:startStream',
    async (
      event,
      token: string,
      threadId: string,
      message: string,
      requestId: string,
      attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
      mode?: 'fast' | 'high' | 'xtreme',
      engine?: 'mastra' | 'langgraph',
      workspace?: { name: string; path: string },
    ) => {
      return startDesktopSseStream({
        target: event.sender,
        requestId,
        url: `${BACKEND_URL}/api/desktop/chat/${threadId}/send`,
        token,
        payload: { message, attachedFiles, mode, engine, workspace, executionId: requestId },
      })
    },
  )

  ipcMain.handle(
    'desktop:chat:sendMessageStream',
    async (
      event,
      payload: {
        token: string
        requestId: string
        threadId: string
        message: string
        attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>
        mode?: 'fast' | 'high' | 'xtreme'
        engine?: 'mastra' | 'langgraph'
        workspace?: { name: string; path: string }
        companyId?: string
      }
    ) => {
      const { token, requestId, threadId, message, attachedFiles, mode, engine, workspace, companyId } = payload
      return startDesktopSseStream({
        target: event.sender,
        requestId,
        url: `${BACKEND_URL}/api/desktop/chat/${threadId}/send`,
        token,
        payload: { message, attachedFiles, mode, engine, workspace, companyId, executionId: requestId },
      })
    },
  )

  ipcMain.handle(
    'desktop:chat:actStream',
    async (
      event,
      payload: {
        token: string
        requestId: string
        executionId: string
        threadId: string
        message?: string
        workspace: { name: string; path: string }
        actionResult?: Record<string, unknown>
        plan?: Record<string, unknown> | null
        mode?: 'fast' | 'high' | 'xtreme'
        engine?: 'mastra' | 'langgraph'
      }
    ) => {
      const { token, requestId, threadId, executionId, ...rest } = payload
      return startDesktopSseStream({
        target: event.sender,
        requestId,
        url: `${BACKEND_URL}/api/desktop/chat/${threadId}/act`,
        token,
        payload: { ...rest, executionId },
      })
    },
  )

  ipcMain.handle('desktop:chat:stopStream', async (_event, requestId: string) => {
    const controller = activeStreamControllers.get(requestId)
    if (!controller) {
      return { success: false, error: 'No active stream found' }
    }
    controller.abort()
    activeStreamControllers.delete(requestId)
    return { success: true }
  })

  ipcMain.handle('desktop:chat:stream-url', (_event, token: string, threadId: string) => {
    return {
      url: `${BACKEND_URL}/api/desktop/chat/${threadId}/stream`,
      token,
    }
  })

  ipcMain.handle(
    'desktop:fetch',
    async (
      _event,
      url: string,
      options: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const res = await net.fetch(url.startsWith('http') ? url : `${BACKEND_URL}${url}`, {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
      })
      const text = await res.text()
      return { status: res.status, body: text }
    },
  )
}
