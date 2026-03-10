import { ipcMain } from 'electron'
import { net } from 'electron'

const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'

export function registerThreadHandlers(): void {
  ipcMain.handle('desktop:threads', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.json()
  })

  ipcMain.handle('desktop:thread', async (_event, token: string, threadId: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.json()
  })

  ipcMain.handle('desktop:thread:create', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    return res.json()
  })

  ipcMain.handle(
    'desktop:thread:add-message',
    async (
      _event,
      token: string,
      threadId: string,
      payload: { role: string; content: string; metadata?: Record<string, unknown> },
    ) => {
      const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return res.json()
    },
  )

  ipcMain.handle('desktop:thread:delete', async (_event, token: string, threadId: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/threads/${threadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return { success: res.ok }
  })
}
