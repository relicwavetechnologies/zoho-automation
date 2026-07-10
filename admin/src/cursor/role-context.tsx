import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

/**
 * Preview role toggle from the mock ("Viewing as Super Admin / Company Admin").
 * Drives the raw tool-I/O gating on the run trace — super admins see raw
 * input/output, company admins see a locked summary. This is a UI preview of
 * the real gate; the live version keys off the authenticated session role.
 */
type RoleContextValue = {
  isSuper: boolean
  toggle: () => void
  label: string
}

const RoleContext = createContext<RoleContextValue | null>(null)

export function RoleProvider({ children }: { children: ReactNode }) {
  const [isSuper, setIsSuper] = useState(true)
  const value = useMemo<RoleContextValue>(
    () => ({ isSuper, toggle: () => setIsSuper((v) => !v), label: isSuper ? "Super Admin" : "Company Admin" }),
    [isSuper],
  )
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext)
  if (!ctx) throw new Error("useRole must be used within RoleProvider")
  return ctx
}
