import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarGroupAction,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from "@/hooks/useThreads"
import ThreadList from "@/containers/ThreadList"
import { DeleteAllThreadsDialog } from "@/containers/dialogs/DeleteAllThreadsDialog"
import { readDivoTeachProfile } from "@/lib/divo-teach-thread"

export function NavChats() {
  const { t } = useTranslation()
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)
  const threads = useThreads((state) => state.threads)
  const deleteAllThreads = useThreads((state) => state.deleteAllThreads)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Teach sessions are a different kind of work from a conversation, and they
  // were interleaving with chats by recency — so a run of them would push the
  // ordinary threads down. Split into their own group rather than relying on
  // the per-row badge to tell them apart.
  const { teachThreads, chatThreads } = useMemo(() => {
    const withoutProject = getFilteredThreads('').filter(
      (thread) => !thread.metadata?.project
    )
    const teach: Thread[] = []
    const chat: Thread[] = []
    for (const thread of withoutProject) {
      if (readDivoTeachProfile(thread.metadata)) teach.push(thread)
      else chat.push(thread)
    }
    return { teachThreads: teach, chatThreads: chat }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFilteredThreads, threads])

  if (teachThreads.length === 0 && chatThreads.length === 0) {
    return null
  }

  return (
    <>
      {chatThreads.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          {/* Pinned to the top of the sidebar scroller while its rows scroll under.
              The overflow action lives inside the label so it travels with it —
              absolutely positioning it against the group would leave it behind. */}
          <SidebarGroupLabel className="sticky top-0 z-10 bg-sidebar">
            {t('common:chats')}
            {chatThreads.length > 1 &&
              <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
                <DropdownMenuTrigger asChild>
                  <SidebarGroupAction className="static ml-auto hover:bg-sidebar-foreground/8">
                    <MoreHorizontal className="text-muted-foreground" />
                    <span className="sr-only">More</span>
                  </SidebarGroupAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start">
                  <DeleteAllThreadsDialog
                    onDeleteAll={deleteAllThreads}
                    onDropdownClose={() => setDropdownOpen(false)}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            }
          </SidebarGroupLabel>
          <SidebarMenu>
            <ThreadList threads={chatThreads} />
          </SidebarMenu>
        </SidebarGroup>
      )}

      {/* Below Chats: conversations are the main list, Teach sessions are the
          smaller side collection you go looking for. */}
      {teachThreads.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel className="sticky top-0 z-10 bg-sidebar">
            {t('common:teachSessions')}
          </SidebarGroupLabel>
          <SidebarMenu>
            {/* The group heading already says Teach — the row badge would
                repeat it, the way the title prefix used to. */}
            <ThreadList threads={teachThreads} hideTeachBadge />
          </SidebarMenu>
        </SidebarGroup>
      )}
    </>
  )
}
