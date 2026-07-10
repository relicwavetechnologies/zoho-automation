import { Bell, Moon, Plus, Search, Sun } from "lucide-react"
import { useRole } from "@/cursor/role-context"
import { useTheme } from "@/lib/use-theme"

export function TopBar() {
  const { label, toggle } = useRole()
  const { resolved, toggle: toggleTheme } = useTheme()
  const isDark = resolved === "dark"

  return (
    <div className="topbar">
      <div className="search"><Search size={15} /> Search runs, people, settings…</div>
      <div style={{ marginLeft: "auto", display: "flex", gap: "9px", alignItems: "center" }}>
        <div className="role-pill" onClick={toggle} role="button" title="Toggle preview role">
          Viewing as <b>{label}</b>
        </div>
        <div className="icon-btn" onClick={toggleTheme} role="button" title={isDark ? "Switch theme (dark)" : "Switch theme (light)"}>
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </div>
        <div className="icon-btn" title="Notifications"><Bell size={16} /></div>
        <button className="btn primary" type="button"><Plus size={15} /> Invite</button>
      </div>
    </div>
  )
}
