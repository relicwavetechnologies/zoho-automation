import { ipcMain } from 'electron'
import { net } from 'electron'

const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'

export function registerChatHandlers(): void {
  ipcMain.handle(
    'desktop:chat:send',
    async (_event, token: string, threadId: string, message: string) => {
      const res = await net.fetch(`${BACKEND_URL}/api/desktop/chat/${threadId}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      return res.json()
    },
  )

  ipcMain.handle(
    'desktop:chat:act',
    async (_event, token: string, threadId: string, payload: Record<string, unknown>) => {
      const res = await net.fetch(`${BACKEND_URL}/api/desktop/chat/${threadId}/act`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return res.json()
    },
  )

  ipcMain.handle(
    'desktop:chat:start-stream',
    async (event, token: string, threadId: string, message: string, requestId: string) => {
      const target = event.sender
      const res = await net.fetch(`${BACKEND_URL}/api/desktop/chat/${threadId}/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ message }),
      })

      if (!res.ok || !res.body) {
        const bodyText = await res.text()
        target.send('desktop:chat:event', {
          requestId,
          event: {
            type: 'error',
            data: bodyText || `Chat stream failed (${res.status})`,
          },
        })
        return { success: false }
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
                target.send('desktop:chat:event', { requestId, event: parsed })
              } catch {
                target.send('desktop:chat:event', {
                  requestId,
                  event: { type: 'error', data: 'Malformed stream event received from backend' },
                })
              }
            }
          }

          const trailing = buffer.trim()
          if (trailing.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trailing.slice(6).trim()) as { type: string; data: unknown }
              target.send('desktop:chat:event', { requestId, event: parsed })
            } catch {
              // ignore final malformed fragment
            }
          }
        } catch (error) {
          target.send('desktop:chat:event', {
            requestId,
            event: {
              type: 'error',
              data: error instanceof Error ? error.message : 'Desktop stream failed',
            },
          })
        }
      })()

      return { success: true }
    },
  )

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
