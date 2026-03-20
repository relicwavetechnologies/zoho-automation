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
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border/50 px-6 sticky top-0 z-30 bg-background/80 backdrop-blur-md">
          <SidebarTrigger className="-ml-2 rounded-lg hover:bg-secondary/50 transition-all text-muted-foreground hover:text-foreground" />
          <Separator orientation="vertical" className="mx-2 h-4 bg-border/50" />
          
          <div className="flex-1 flex items-center gap-4">
            <div className="relative w-full max-w-[420px] group hidden md:block">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 transition-colors group-focus-within:text-primary/80" />
              <Input
                type="search"
                placeholder="Search control plane..."
                className="w-full bg-black/20 pl-10 h-9 text-[12px] border-border/50 focus-visible:ring-primary/20 focus-visible:bg-black/40 transition-all rounded-full shadow-sm"
              />
            </div>
          </div>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-secondary/50 transition-all">
              <HelpCircle className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-secondary/50 relative transition-all">
              <Bell className="h-4 w-4" />
              <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]" />
            </Button>
            <Separator orientation="vertical" className="mx-3 h-4 bg-border/50" />
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-secondary/40 border border-border/50 shadow-sm">
              <span className="text-[10px] font-black uppercase tracking-[0.1em] text-muted-foreground/80">
                {isSuperAdmin ? "Global" : "Company"}
              </span>
              <div className="h-1.5 w-1.5 rounded-full bg-primary/80 animate-pulse" />
            </div>
          </div>
        </header>
        
        <main className="flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-auto bg-black/[0.02]">
            <div className="mx-auto w-full max-w-[1400px] p-8 lg:p-10 animate-in fade-in slide-in-from-bottom-2 duration-700">
              <Outlet />
            </div>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
