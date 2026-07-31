import { NavLink } from "react-router-dom"
import {
  Activity,
  Building2,
  Diamond,
  LayoutDashboard,
  Library,
  LogOut,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from "lucide-react"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useRole } from "@/cursor/role-context"

/** Sidebar nav — static structure from the mock; each item routes via NavLink. */
const NAV: { label: string; items: { to: string; icon: LucideIcon; label: string }[] }[] = [
  {
    label: "Workspace",
    items: [
      { to: "/home", icon: LayoutDashboard, label: "Overview" },
      { to: "/people", icon: Users, label: "People" },
      { to: "/departments", icon: Building2, label: "Departments" },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/ai-ops", icon: Activity, label: "AI Ops" },
      { to: "/skills", icon: Library, label: "Skills Lab" },
      { to: "/guardrails", icon: Shield, label: "Guardrails" },
      { to: "/web-search", icon: Search, label: "Web Search" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/controls", icon: SlidersHorizontal, label: "Company controls" },
      { to: "/settings", icon: Settings, label: "Settings" },
    ],
  },
]

export function AdminSidebar() {
  const { logout, session } = useAdminAuth()
  const { isSuper, label } = useRole()
  // Company admins are scoped to one workspace; super admins oversee all of them.
  const workspaceLabel = session?.companyName ?? (session?.role === "SUPER_ADMIN" ? "All workspaces" : "—")

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="mark"><Diamond size={14} fill="currentColor" strokeWidth={0} /></div>
        <b className="display">Divo</b>
      </div>

      {NAV.map((section) => (
        <div key={section.label}>
          <div className="nav-label">{section.label}</div>
          {section.items.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="g"><item.icon size={16} /></span> {item.label}
            </NavLink>
          ))}
        </div>
      ))}

      <div className="sidebar-foot">
        <div className="acct">
          <div className="avatar">{isSuper ? "S" : "C"}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "12.5px", fontWeight: 500 }}>{label}</div>
            <div style={{ fontSize: "11px" }} className="muted">{workspaceLabel}</div>
          </div>
          <span className="muted" style={{ cursor: "pointer", display: "inline-flex" }} onClick={() => void logout()} title="Sign out" role="button">
            <LogOut size={15} />
          </span>
        </div>
      </div>
    </aside>
  )
}
