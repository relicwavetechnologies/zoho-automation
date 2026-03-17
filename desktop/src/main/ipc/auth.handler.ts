import { ipcMain, shell } from 'electron'
import { net } from 'electron'

const BACKEND_URL = process.env.CURSORR_BACKEND_URL ?? 'http://localhost:8000'

export function registerAuthHandlers(): void {
  ipcMain.handle('desktop-auth:open-lark-login', async () => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/lark/authorize-url`)
    const payload = (await res.json()) as {
      success?: boolean
      data?: { authorizeUrl?: string }
      message?: string
    }
    const authorizeUrl = payload?.data?.authorizeUrl
    if (!res.ok || !authorizeUrl) {
      throw new Error(payload?.message || 'Could not start desktop Lark sign-in')
    }
    await shell.openExternal(authorizeUrl)
  })

  ipcMain.handle('desktop-auth:exchange-lark', async (_event, code: string, state: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/lark/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })
    return res.json()
  })

  ipcMain.handle('desktop-auth:open-google-connect', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/google/authorize-url`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const payload = (await res.json()) as {
      success?: boolean
      data?: { authorizeUrl?: string }
      message?: string
    }
    const authorizeUrl = payload?.data?.authorizeUrl
    if (!res.ok || !authorizeUrl) {
      throw new Error(payload?.message || 'Could not start Google OAuth')
    }
    await shell.openExternal(authorizeUrl)
    return payload
  })

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

  ipcMain.handle('desktop-auth:google-status', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/google/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.json()
  })

  ipcMain.handle('desktop-auth:usage', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/usage`, {
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

  ipcMain.handle('desktop-auth:unlink-lark', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/lark/unlink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.json()
  })

  ipcMain.handle('desktop-auth:unlink-google', async (_event, token: string) => {
    const res = await net.fetch(`${BACKEND_URL}/api/desktop/auth/google/unlink`, {
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
