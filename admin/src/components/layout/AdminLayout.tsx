import { Outlet } from "react-router-dom"
import { Menu, Search, Bell, HelpCircle } from "lucide-react"

import { useAdminAuth } from "../../auth/AdminAuthProvider"
import { AppSidebar } from "./AppSidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "../ui/sidebar"
import { Separator } from "../ui/separator"
import { Button } from "../ui/button"
import { Input } from "../ui/input"

export function AdminLayout() {
  const { session } = useAdminAuth()
  const isSuperAdmin = session?.role === "SUPER_ADMIN"

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="bg-background/50">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border/40 px-6 sticky top-0 z-30 bg-background/60 backdrop-blur-xl">
          <SidebarTrigger className="-ml-2 hover:bg-accent/50 transition-colors" />
          <Separator orientation="vertical" className="mr-2 h-4 bg-border/40" />
          <div className="flex-1 flex items-center gap-4">
            <div className="relative w-full max-w-[420px] group hidden md:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/70 transition-colors group-focus-within:text-primary" />
              <Input
                type="search"
                placeholder="Search control plane..."
                className="w-full bg-muted/30 pl-9 h-9 text-xs border-border/20 focus-visible:ring-primary/20 focus-visible:bg-background/80 transition-all rounded-full"
              />
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground/80 hover:text-foreground hover:bg-accent/50">
              <HelpCircle className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground/80 hover:text-foreground hover:bg-accent/50 relative">
              <Bell className="h-4 w-4" />
              <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]" />
            </Button>
            <Separator orientation="vertical" className="mx-2 h-4 bg-border/40" />
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-muted/40 border border-border/20 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/90">
                {isSuperAdmin ? "Global" : "Company"}
              </span>
              <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-7xl p-6 lg:p-8 animate-in fade-in slide-in-from-bottom-2 duration-700">
              <Outlet />
            </div>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
