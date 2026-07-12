import { DownloadManagement } from '@/containers/DownloadManegement'
import { NavChats } from './NavChats'
import { NavMain } from './NavMain'
import { NavProjects } from './NavProjects'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { DivoDexWordmark } from '@/components/DivoDexBrand'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import {
  type DivoSessionStatus,
  getDivoSessionStatus,
} from '@/lib/divo-auth'

function DivoProfileFooter() {
  const [status, setStatus] = useState<DivoSessionStatus | null>(null)
  const [avatarFailed, setAvatarFailed] = useState(false)

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
  const role = status.role?.replace(/_/g, ' ').toLowerCase() || 'member'
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'D'
  const avatarUrl = status.avatarUrl?.trim()

  return (
    <SidebarFooter className="border-t border-sidebar-border/70 p-2">
      <div className="group-data-[collapsible=icon]:hidden flex min-w-0 items-center gap-2 rounded-lg border border-sidebar-border/70 bg-sidebar-accent/30 p-2">
        <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border border-sidebar-border bg-sidebar-accent text-xs font-medium">
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
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs capitalize text-muted-foreground">{role}</p>
        </div>
      </div>
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
