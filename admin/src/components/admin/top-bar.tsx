import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Bell, Menu, Search, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { AdminSidebar } from "@/components/admin/admin-sidebar"
import { ThemeToggle } from "@/components/admin/theme-toggle"

const commandItems = [
  { label: "Home", path: "/home" },
  { label: "People", path: "/people" },
  { label: "Departments", path: "/departments" },
  { label: "AI Ops", path: "/ai-ops" },
  { label: "Agents", path: "/agents" },
  { label: "Settings", path: "/settings" },
]

export function TopBar() {
  const [commandOpen, setCommandOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <TooltipProvider delayDuration={100}>
      <header className="flex h-12 shrink-0 items-center gap-2 px-3 md:px-5">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full lg:hidden" aria-label="Open navigation">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[var(--sidebar-width)] p-0">
            <AdminSidebar mobile onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>

        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-border/50 bg-card px-3 text-left text-[12px] text-muted-foreground shadow-soft transition-colors hover:bg-secondary md:max-w-md"
        >
          <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Search pages, settings, and admin sections...</span>
        </button>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-full border-border/50 bg-card shadow-soft hover:bg-card" aria-label="Security status">
                <ShieldCheck className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Admin session protected</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-full border-border/50 bg-card shadow-soft hover:bg-card" aria-label="Notifications">
                <Bell className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Notifications</TooltipContent>
          </Tooltip>
        </div>

        <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
          <CommandInput placeholder="Search admin pages..." />
          <CommandList>
            <CommandEmpty>No page found.</CommandEmpty>
            <CommandGroup heading="Navigation">
              {commandItems.map((item) => (
                <CommandItem
                  key={item.path}
                  onSelect={() => {
                    setCommandOpen(false)
                    navigate(item.path)
                  }}
                >
                  <Link to={item.path}>{item.label}</Link>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      </header>
    </TooltipProvider>
  )
}
