import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { UserSession } from '../types'

interface AuthState {
  session: UserSession | null
  token: string | null
  loading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<void>
  openBrowserLogin: () => Promise<void>
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
    const unsub = window.desktopAPI.auth.onCallback(async ({ code }) => {
      setLoading(true)
      setError(null)
      try {
        const res = await window.desktopAPI.auth.exchange(code)
        if (res.success && res.data) {
          const { token: newToken, session: newSession } = res.data as {
            token: string
            session: UserSession
          }
          setToken(newToken)
          setSession(newSession)
          localStorage.setItem(TOKEN_KEY, newToken)
        } else {
          setError('Authentication failed. Please try again.')
        }
      } catch {
        setError('Authentication exchange failed.')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setError(null)
    setLoading(true)
    try {
      const res = await window.desktopAPI.auth.login(email, password)
      if (res.success && res.data) {
        const { token: newToken, session: newSession } = res.data as {
          token: string
          session: UserSession
        }
        setToken(newToken)
        setSession(newSession)
        localStorage.setItem(TOKEN_KEY, newToken)
      } else {
        setError('Invalid credentials. Please try again.')
      }
    } catch {
      setError('Login failed. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  const openBrowserLogin = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await window.desktopAPI.auth.openLogin()
    } catch {
      setError('Could not open the browser login flow.')
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
    <AuthContext.Provider value={{ session, token, loading, error, login, openBrowserLogin, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
