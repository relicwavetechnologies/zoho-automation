import {
  Building2,
  LayoutDashboard,
  Settings2,
  Users,
  Workflow,
  Activity,
  LogOut,
  User,
  ChevronUp,
} from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"

import { cn } from "../../lib/utils"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "../ui/sidebar"
import { useAdminAuth } from "../../auth/AdminAuthProvider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { Avatar, AvatarFallback } from "../ui/avatar"
import { Logo } from "../Logo"

const iconMap: Record<string, any> = {
  Home: LayoutDashboard,
  People: Users,
  Departments: Building2,
  "AI Ops": Workflow,
  Settings: Settings2,
  Workspaces: Activity,
}

export function AppSidebar() {
  const { navItems, session, logout } = useAdminAuth()
  const location = useLocation()
  const isSuperAdmin = session?.role === "SUPER_ADMIN"
  const accountLabel = isSuperAdmin ? "Super Admin" : "Admin"
  const accountSecondary = session?.companyId || session?.userId || "Account"
  const avatarInitial = accountLabel[0] || "A"

  return (
    <Sidebar collapsible="icon" className="border-r border-border bg-background/50 backdrop-blur-md">
      <SidebarHeader className="h-14 border-b border-border/50 flex items-center px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/20 border border-border shadow-sm group-data-[collapsible=icon]:mx-auto">
            <Logo size={18} />
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden animate-in fade-in duration-500">
            <span className="text-[10px] font-black uppercase tracking-[0.25em] text-primary/80">Divo</span>
            <span className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold opacity-40">Admin</span>
          </div>
        </div>
      </SidebarHeader>
      
      <SidebarContent className="px-2 py-6">
        <SidebarGroup>
          <SidebarGroupLabel className="px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30 mb-4">
            Platform
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navItems.map((item) => {
                const Icon = iconMap[item.label] || LayoutDashboard
                const isActive = location.pathname === item.path

                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      className={cn(
                        "transition-all duration-200 h-10 px-3 rounded-xl",
                        isActive 
                          ? "bg-secondary text-foreground border border-border shadow-sm" 
                          : "text-muted-foreground/70 hover:bg-secondary/30 hover:text-foreground border border-transparent"
                      )}
                    >
                      <NavLink to={item.path} className="flex items-center gap-3 w-full">
                        <Icon className={cn(
                          "h-[18px] w-[18px] transition-colors opacity-70",
                          isActive ? "text-primary opacity-100" : ""
                        )} strokeWidth={isActive ? 2.5 : 2} />
                        <span className="font-semibold text-[13px] tracking-tight">{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-border/50 p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-secondary data-[state=open]:text-foreground hover:bg-secondary/50 transition-all rounded-xl border border-transparent data-[state=open]:border-border shadow-sm"
                >
                  <div className="h-9 w-9 rounded-xl border border-border bg-black/20 flex items-center justify-center shadow-sm transition-transform group-hover:scale-105">
                    <span className="text-xs font-bold text-muted-foreground/60 uppercase">
                      {avatarInitial}
                    </span>
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden ml-1">
                    <span className="truncate font-bold text-foreground/90 tracking-tight">
                      {accountLabel}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground/40 font-medium">
                      {accountSecondary}
                    </span>
                  </div>
                  <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground/30 group-data-[collapsible=icon]:hidden" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-xl border-border shadow-2xl bg-popover/95 backdrop-blur-xl p-1"
                align="end"
                sideOffset={12}
              >
                <div className="px-2 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
                  Account Control
                </div>
                <DropdownMenuItem
                  onClick={() => void logout()}
                  className="text-red-500/80 focus:bg-red-500/10 focus:text-red-500 cursor-pointer font-bold m-1 rounded-lg gap-2 transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
