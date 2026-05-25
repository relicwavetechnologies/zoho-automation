import { useEffect, useMemo, useState } from "react"
import { NavLink, useLocation } from "react-router-dom"
import {
  Activity,
  Bot,
  Brain,
  Building2,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Settings2,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { cn } from "@/lib/utils"
import { LogoMark } from "@/components/admin/logo-mark"
import type { NavItem, NavSection } from "@/components/admin/types"

const SIDEBAR_COLLAPSED_KEY = "divo_admin_sidebar_collapsed"

const iconMap = {
  home: LayoutDashboard,
  overview: LayoutDashboard,
  workspaces: Activity,
  people: Users,
  members: Users,
  departments: Building2,
  "ai-ops": Workflow,
  "ai-providers": Sparkles,
  memories: Brain,
  settings: Settings2,
} as const

const fallbackItems: NavItem[] = [
  { id: "home", label: "Home", path: "/home", icon: LayoutDashboard },
  { id: "people", label: "People", path: "/people", icon: Users },
  { id: "departments", label: "Departments", path: "/departments", icon: Building2 },
  { id: "ai-ops", label: "AI Ops", path: "/ai-ops", icon: Workflow },
  { id: "ai-providers", label: "AI Providers", path: "/ai-providers", icon: Sparkles },
  { id: "memories", label: "Memories", path: "/memories", icon: Brain },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings2 },
]

const toNavItem = (item: { id: string; label: string; path: string }): NavItem => ({
  id: item.id,
  label: item.label,
  path: item.path,
  icon: iconMap[item.id as keyof typeof iconMap] ?? LayoutDashboard,
})

type AdminSidebarProps = {
  mobile?: boolean
  onNavigate?: () => void
}

export function AdminSidebar({ mobile, onNavigate }: AdminSidebarProps) {
  const { navItems, session, logout } = useAdminAuth()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true")
  const location = useLocation()

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  const sections = useMemo<NavSection[]>(() => {
    const base = navItems.length ? navItems.map(toNavItem) : fallbackItems
    return [
      {
        label: "Workspace",
        items: base.filter((item) => ["home", "workspaces", "people", "departments"].includes(item.id)),
      },
      {
        label: "Operations",
        items: [
          ...base.filter((item) => ["ai-ops", "ai-providers", "memories", "settings"].includes(item.id)),
          { id: "agents", label: "Agents", path: "/agents", icon: Bot },
        ],
      },
    ].filter((section) => section.items.length > 0)
  }, [navItems])

  const effectiveCollapsed = mobile ? false : collapsed
  const accountLabel = session?.role === "SUPER_ADMIN" ? "Super Admin" : "Company Admin"
  const accountSecondary = session?.companyId ?? session?.userId ?? "Signed in"

  return (
    <TooltipProvider delayDuration={100}>
      <aside
        className={cn(
          "flex h-full flex-col bg-transparent transition-[width] duration-300",
          mobile ? "w-full" : effectiveCollapsed ? "w-[var(--sidebar-width-collapsed)]" : "w-[var(--sidebar-width)]",
        )}
      >
        <div className="flex h-12 items-center justify-between px-3 pt-1">
          <LogoMark collapsed={effectiveCollapsed} />
          {!mobile ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              aria-label={effectiveCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setCollapsed((value) => !value)}
            >
              {effectiveCollapsed ? <ChevronRight className="h-4 w-4" strokeWidth={1.5} /> : <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />}
            </Button>
          ) : null}
        </div>
        <ScrollArea className="flex-1 px-3">
          <nav className="space-y-5 py-2" aria-label="Admin navigation">
            {sections.map((section) => (
              <div key={section.label} className="space-y-1">
                {!effectiveCollapsed ? (
                  <p className="px-2.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">{section.label}</p>
                ) : null}
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = location.pathname === item.path || location.pathname.startsWith(`${item.path}/`)
                    const link = (
                      <NavLink
                        to={item.path}
                        onClick={onNavigate}
                        className={cn(
                          "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-normal text-muted-foreground transition-colors hover:bg-mat hover:text-foreground",
                          active && "border border-border/60 bg-mat/40 text-foreground hover:bg-mat/40 hover:text-foreground",
                          effectiveCollapsed && "justify-center px-0",
                        )}
                        aria-current={active ? "page" : undefined}
                      >
                        <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                        {!effectiveCollapsed ? <span className="truncate">{item.label}</span> : <span className="sr-only">{item.label}</span>}
                      </NavLink>
                    )
                    return effectiveCollapsed ? (
                      <Tooltip key={item.id}>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <div key={item.id}>{link}</div>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>
        </ScrollArea>
        <div className="p-2">
          <Separator className="mb-2" />
          <div className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-mat", effectiveCollapsed && "justify-center px-0")}>
            <Avatar className="h-6 w-6">
              <AvatarFallback className="text-[10px] font-medium">{accountLabel.slice(0, 1)}</AvatarFallback>
            </Avatar>
            {!effectiveCollapsed ? (
              <>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-normal">{accountLabel}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{accountSecondary}</p>
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 rounded-md" onClick={() => void logout()} aria-label="Sign out">
                  <LogOut className="h-3 w-3" strokeWidth={1.5} />
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </aside>
    </TooltipProvider>
  )
}
