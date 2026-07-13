import { DownloadManagement } from '@/containers/DownloadManegement'
import { NavChats } from './NavChats'
import { NavMain } from './NavMain'
import { NavProjects } from './NavProjects'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useEffect, useState } from 'react'
import { UserRound, LogOut, Settings2, ChevronsUpDown, Building2 } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { DivoDexWordmark } from '@/components/DivoDexBrand'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import { route } from '@/constants/routes'
import {
  type DivoSessionStatus,
  getDivoSessionStatus,
} from '@/lib/divo-auth'

function DivoProfileFooter() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<DivoSessionStatus | null>(null)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    const refresh = () => {
      void getDivoSessionStatus()
        .then((next) => {
          if (!cancelled) setStatus(next.configured ? next : null)
        })
        .catch(() => {
          if (!cancelled) setStatus(null)
        })
    }

    refresh()
    if (IS_TAURI) {
      void listen<{ configured?: boolean }>('divo-session-changed', (event) => {
        if (event.payload?.configured) {
          refresh()
        } else {
          setStatus(null)
        }
      }).then((dispose) => {
        if (cancelled) dispose()
        else unlisten = dispose
      })
    }

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    setAvatarFailed(false)
  }, [status?.avatarUrl])

  if (!status) return null

  const name = status.name || status.email || 'Divo Dex user'
  const email = status.email
  const role = status.role?.replace(/_/g, ' ').toLowerCase() || 'member'
  const departmentName =
    status.departments.find((dept) => dept.id === status.departmentId)?.name ??
    status.departmentId ??
    null
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'D'
  const avatarUrl = status.avatarUrl?.trim()

  const Avatar = ({ className }: { className?: string }) => (
    <div
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-md border border-sidebar-border bg-sidebar-accent text-xs font-medium',
        className
      )}
    >
      {avatarUrl && !avatarFailed ? (
        <img
          src={avatarUrl}
          alt={`${name} profile`}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setAvatarFailed(true)}
        />
      ) : (
        initials || <UserRound className="size-4" />
      )}
    </div>
  )

  const handleSignOut = async () => {
    if (isSigningOut) return
    setIsSigningOut(true)
    try {
      await invoke('divo_clear_session')
      await invoke('pi_stop').catch(() => undefined)
      // The gate listens for `divo-session-changed` and returns to sign-in.
    } catch (error) {
      toast.error('Failed to sign out', { description: String(error) })
      setIsSigningOut(false)
    }
  }

  return (
    <SidebarFooter className="border-t border-sidebar-border/70 p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="group-data-[collapsible=icon]:hidden flex min-w-0 items-center gap-2 rounded-lg border border-sidebar-border/70 bg-sidebar-accent/30 p-2 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent/60"
          >
            <Avatar className="size-9" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs capitalize text-muted-foreground">
                {role}
              </p>
            </div>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          sideOffset={8}
          className="w-60"
        >
          <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
            <Avatar className="size-9" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{name}</p>
              {email ? (
                <p className="truncate text-xs text-muted-foreground">{email}</p>
              ) : null}
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          <div className="px-2 py-1.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <UserRound className="size-3.5" />
                Role
              </span>
              <span className="truncate capitalize font-medium">{role}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Building2 className="size-3.5" />
                Department
              </span>
              <span className="truncate font-medium">
                {departmentName ?? (
                  <span className="text-muted-foreground">None</span>
                )}
              </span>
            </div>
          </div>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => {
              void navigate({ to: route.settings.divo })
            }}
          >
            <Settings2 className="size-4" />
            Workspace settings
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={isSigningOut}
            onSelect={(event) => {
              event.preventDefault()
              void handleSignOut()
            }}
          >
            <LogOut className="size-4" />
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarFooter>
  )
}

export function LeftSidebar() {
  const { open: isLeftPanelOpen } = useLeftPanel()
  // Right-align the header when native controls own the top-left (macOS, or a Linux
  // DE placing buttons left); the wordmark moves into the right cluster except on macOS.
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const controlsOnLeft = !IS_MACOS && leftButtons > 0
  const reserveLeft = IS_MACOS || controlsOnLeft
  return (
    <div className='relative z-50'>
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader className="flex px-1">
          <div className={cn("flex items-center w-full justify-between", reserveLeft && "justify-end")}>
            {!reserveLeft && <DivoDexWordmark className="ml-2" />}
            <div className="flex items-center">
              {controlsOnLeft && (
                <DivoDexWordmark className="mr-2" />
              )}
              {isLeftPanelOpen && <DownloadManagement />}
              <SidebarTrigger className="text-muted-foreground rounded-full hover:bg-sidebar-foreground/8! -mt-0.5 relative z-50 ml-0.5" />
            </div>
          </div>
          <NavMain />
        </SidebarHeader>
        <SidebarContent className="mask-b-from-95% mask-t-from-98%">
          <NavProjects />
          <NavChats />
        </SidebarContent>
        <DivoProfileFooter />
        <SidebarRail />
      </Sidebar>
    </div>
  )
}
