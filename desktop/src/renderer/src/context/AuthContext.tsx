import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { UserSession } from '../types'

interface AuthState {
  session: UserSession | null
  token: string | null
  loading: boolean
  error: string | null
  openLarkLogin: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

const TOKEN_KEY = 'cursorr_desktop_token'

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<UserSession | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const bootstrap = useCallback(async (t: string) => {
    try {
      const res = await window.desktopAPI.auth.me(t)
      if (res.success && res.data) {
        setSession(res.data as UserSession)
        setToken(t)
        localStorage.setItem(TOKEN_KEY, t)
      } else {
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
        setSession(null)
      }
    } catch {
      localStorage.removeItem(TOKEN_KEY)
      setToken(null)
      setSession(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Bootstrap on mount if we have a stored token
  useEffect(() => {
    if (token) {
      bootstrap(token)
    } else {
      setLoading(false)
    }
  }, [])

  // Listen for auth callback from main process (custom protocol)
  useEffect(() => {
    const unsub = window.desktopAPI.auth.onCallback(async ({ code, state, error }) => {
      if (error) {
        setError(`Lark sign-in failed: ${error}`)
        setLoading(false)
        return
      }
      if (!code || !state) {
        setError('Desktop Lark callback is missing required OAuth data.')
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const res = await window.desktopAPI.auth.exchangeLark(code, state)
        if (res.success && res.data) {
          const { token: newToken, session: newSession } = res.data as {
            token: string
            session: UserSession
          }
          setToken(newToken)
          setSession(newSession)
          localStorage.setItem(TOKEN_KEY, newToken)
        } else {
          setError('Lark authentication failed. Please try again.')
        }
      } catch {
        setError('Lark authentication exchange failed.')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [])

  const openLarkLogin = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await window.desktopAPI.auth.openLarkLogin()
    } catch {
      setError('Could not open the Lark login flow.')
      setLoading(false)
      return
    }
    setLoading(false)
  }, [])

  const logout = useCallback(async () => {
    if (token) {
      try {
        await window.desktopAPI.auth.logout(token)
      } catch {
        // proceed with local logout regardless
      }
    }
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setSession(null)
  }, [token])

  return (
    <AuthContext.Provider value={{ session, token, loading, error, openLarkLogin, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
