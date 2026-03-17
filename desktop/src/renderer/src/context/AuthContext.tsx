import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { DepartmentSummary, UserSession } from '../types'

interface AuthState {
  session: UserSession | null
  token: string | null
  departments: DepartmentSummary[]
  selectedDepartmentId: string | null
  loading: boolean
  error: string | null
  setSelectedDepartmentId: (departmentId: string | null) => void
  openLarkLogin: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

const TOKEN_KEY = 'cursorr_desktop_token'
const departmentStorageKey = (companyId: string) => `cursorr_desktop_department_${companyId}`

const resolveSelectedDepartmentId = (nextSession: UserSession): string | null => {
  const departments = nextSession.departments ?? []
  if (departments.length === 0) return null
  if (departments.length === 1) return departments[0].id

  const stored = localStorage.getItem(departmentStorageKey(nextSession.companyId))
  if (stored && departments.some((department) => department.id === stored)) {
    return stored
  }

  return nextSession.resolvedDepartmentId ?? null
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<UserSession | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [selectedDepartmentId, setSelectedDepartmentIdState] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const bootstrap = useCallback(async (t: string) => {
    try {
      const res = await window.desktopAPI.auth.me(t)
      if (res.success && res.data) {
        const nextSession = res.data as UserSession
        setSession(nextSession)
        setSelectedDepartmentIdState(resolveSelectedDepartmentId(nextSession))
        setToken(t)
        localStorage.setItem(TOKEN_KEY, t)
      } else {
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
        setSession(null)
        setSelectedDepartmentIdState(null)
      }
    } catch {
      localStorage.removeItem(TOKEN_KEY)
      setToken(null)
      setSession(null)
      setSelectedDepartmentIdState(null)
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
          setSelectedDepartmentIdState(resolveSelectedDepartmentId(newSession))
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
    setSelectedDepartmentIdState(null)
  }, [token])

  useEffect(() => {
    if (!session) return
    if (selectedDepartmentId) {
      localStorage.setItem(departmentStorageKey(session.companyId), selectedDepartmentId)
    } else {
      localStorage.removeItem(departmentStorageKey(session.companyId))
    }
  }, [selectedDepartmentId, session])

  const setSelectedDepartmentId = useCallback((departmentId: string | null) => {
    if (!session) {
      setSelectedDepartmentIdState(null)
      return
    }
    if (departmentId === null) {
      setSelectedDepartmentIdState(null)
      return
    }
    const departments = session.departments ?? []
    if (!departments.some((department) => department.id === departmentId)) {
      return
    }
    setSelectedDepartmentIdState(departmentId)
  }, [session])

  return (
    <AuthContext.Provider
      value={{
        session,
        token,
        departments: session?.departments ?? [],
        selectedDepartmentId,
        loading,
        error,
        setSelectedDepartmentId,
        openLarkLogin,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
