import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useAdminAuth } from "@/auth/AdminAuthProvider"

/**
 * Mirrors the authenticated admin session for presentation. The backend remains
 * authoritative for trace redaction and all admin authorization decisions.
 */
type RoleContextValue = {
  isSuper: boolean
  canViewRawExecutionData: boolean
  label: string
}

const RoleContext = createContext<RoleContextValue | null>(null)

export function RoleProvider({ children }: { children: ReactNode }) {
  const { session } = useAdminAuth()
  const isSuper = session?.role === "SUPER_ADMIN"
  const canViewRawExecutionData = session?.role === "SUPER_ADMIN" || session?.role === "COMPANY_ADMIN"
  const value = useMemo<RoleContextValue>(
    () => ({ isSuper, canViewRawExecutionData, label: isSuper ? "Super Admin" : "Company Admin" }),
    [canViewRawExecutionData, isSuper],
  )
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext)
  if (!ctx) throw new Error("useRole must be used within RoleProvider")
  return ctx
}
