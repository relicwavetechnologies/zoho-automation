import { Outlet } from "react-router-dom"
import { AdminSidebar } from "@/components/admin/admin-sidebar"
import { TopBar } from "@/components/admin/top-bar"
import { RoleProvider } from "@/cursor/role-context"

/**
 * Cursor-design app shell — mirrors the html-plans mock exactly. The root
 * carries `.cur` (design-system scope + fonts/canvas) and `.app` (flex layout).
 * RoleProvider backs the "Viewing as …" toggle that gates raw trace I/O.
 */
export function AdminShell() {
  return (
    <RoleProvider>
      <div className="cur app">
        <AdminSidebar />
        <div className="shell">
          <TopBar />
          <div className="content">
            <div className="scroll">
              <Outlet />
            </div>
          </div>
        </div>
      </div>
    </RoleProvider>
  )
}
