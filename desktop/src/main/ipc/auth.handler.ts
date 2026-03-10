import { ipcMain, shell } from 'electron'
import { net } from 'electron'

const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'

export function registerAuthHandlers(): void {
  ipcMain.handle('desktop-auth:login', async (_event, email: string, password: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/member/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    return res.json()
  })

  ipcMain.handle('desktop-auth:exchange', async (_event, code: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    return res.json()
  })

  ipcMain.handle('desktop-auth:me', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.json()
  })

  ipcMain.handle('desktop-auth:logout', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.json()
  })

  ipcMain.handle('desktop-auth:open-login', async () => {
    const webAppUrl = process.env.CURSORR_WEB_APP_URL ?? 'http://localhost:5173'
    shell.openExternal(`${webAppUrl}/desktop-login?desktop=true`)
  })
}
