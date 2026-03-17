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

  return (
    <Sidebar collapsible="icon" className="border-r border-border/40 bg-sidebar shadow-xl">
      <SidebarHeader className="h-14 border-b border-border/40 flex items-center px-4 bg-sidebar/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm shadow-[0_0_15px_rgba(var(--primary),0.3)]">
            C
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden animate-in fade-in duration-500">
            <span className="text-sm font-bold tracking-tight text-foreground">Control Hub</span>
            <span className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold opacity-70">Admin Core</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">
            Platform
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
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
                        "transition-all duration-200 h-10 px-3 rounded-lg",
                        isActive 
                          ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary" 
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      )}
                    >
                      <NavLink to={item.path} className="flex items-center gap-3 w-full">
                        <Icon className={cn(
                          "h-[18px] w-[18px] transition-colors",
                          isActive ? "text-primary" : "text-muted-foreground/70"
                        )} strokeWidth={isActive ? 2.5 : 2} />
                        <span className="font-semibold text-sm tracking-tight">{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-border/40 p-3 bg-sidebar/30">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-accent/50 data-[state=open]:text-foreground hover:bg-accent/30 transition-all rounded-xl border border-transparent data-[state=open]:border-border/40"
                >
                  <Avatar className="h-9 w-9 rounded-lg border border-border/40 shadow-sm transition-transform group-hover:scale-105">
                    <AvatarFallback className="rounded-lg bg-primary/10 text-primary text-xs font-bold uppercase border border-primary/20">
                      {session?.email?.[0] || <User className="h-4 w-4" />}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden ml-1">
                    <span className="truncate font-bold text-foreground tracking-tight">
                      {isSuperAdmin ? "Super Admin" : "Company Admin"}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground font-medium opacity-80">
                      {session?.email || "Account"}
                    </span>
                  </div>
                  <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground/50 group-data-[collapsible=icon]:hidden" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-xl border-border/40 shadow-2xl bg-popover/95 backdrop-blur-xl"
                align="end"
                sideOffset={12}
              >
                <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
                  Settings
                </div>
                <DropdownMenuItem
                  onClick={() => void logout()}
                  className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer font-bold m-1 rounded-lg gap-2"
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
