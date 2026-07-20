import { LucideIcon } from 'lucide-react'
import { route } from '@/constants/routes'

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { Link, useNavigate } from '@tanstack/react-router'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import React, { useRef } from 'react'
import {
  SearchIcon,
  type SearchIconHandle,
} from '@/components/animated-icon/search'
import {
  MessageCircleIcon,
  type MessageCircleIconHandle,
} from '@/components/animated-icon/message-circle'
import {
  SettingsIcon,
  type SettingsIconHandle,
} from '@/components/animated-icon/settings'
import {
  BotIcon,
  type BotIconHandle,
} from '@/components/animated-icon/bot'
import {
  BlocksIcon,
  type BlocksIconHandle,
} from '@/components/animated-icon/blocks'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'

/**
 * Shortcut chips are revealed on row hover rather than shown permanently. Three
 * of the five rows carry one, and standing they read as a second column of
 * content competing with the labels.
 */
type AnimatedIconHandle =
  | SearchIconHandle
  | MessageCircleIconHandle
  | SettingsIconHandle
  | BotIconHandle
  | BlocksIconHandle

type NavMainItem = {
  title: string
  url?: string
  icon?: LucideIcon | React.ComponentType<{ className?: string }>
  animatedIcon?: React.ForwardRefExoticComponent<
    {
      className?: string
      size?: number
    } & React.RefAttributes<AnimatedIconHandle>
  >
  isActive?: boolean
  shortcut?: React.ReactNode
  onClick?: () => void
}

const getNavMainItems = (
  onSearch: () => void,
  onNewChat: () => void,
  onJanClaw: () => void
): NavMainItem[] => [
  {
    title: 'common:newChat',
    animatedIcon: MessageCircleIcon,
    onClick: onNewChat,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0 opacity-0 transition-opacity group-hover/menu-item:opacity-100">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">{PlatformShortcuts[ShortcutAction.NEW_CHAT].key}</Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:newAgentChat',
    animatedIcon: BotIcon,
    onClick: onJanClaw,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0 opacity-0 transition-opacity group-hover/menu-item:opacity-100">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">{PlatformShortcuts[ShortcutAction.NEW_AGENT_CHAT].key}</Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:search',
    animatedIcon: SearchIcon,
    onClick: onSearch,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0 opacity-0 transition-opacity group-hover/menu-item:opacity-100">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">{PlatformShortcuts[ShortcutAction.SEARCH].key} </Kbd>
      </KbdGroup>
    ),
  },
  {
    // Tools was the one row here still on a static lucide glyph, so it alone
    // stayed dead while every neighbour animated on hover. The puzzle piece
    // was also the wrong read: it says "add-on", and at 16px its interlocking
    // curves collapse into a squiggle. Blocks is geometric enough to survive
    // that size, and a block sliding into place is what this page is about.
    title: 'common:plugins',
    url: route.plugins.index,
    animatedIcon: BlocksIcon,
  },
  {
    title: 'common:settings',
    url: route.settings.general,
    animatedIcon: SettingsIcon,
  },
]

function NavMainItemWithAnimatedIcon({
  item,
  label,
}: {
  item: NavMainItem
  label: string
}) {
  const iconRef = useRef<AnimatedIconHandle>(null)
  const AnimatedIcon = item.animatedIcon!

  const content = (
    <>
      <AnimatedIcon ref={iconRef} className="text-foreground/70" size={16} />
      <span>{label}</span>
      {item.shortcut}
    </>
  )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild={!!item.url}
        isActive={item.isActive}
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
        onClick={item.onClick}
      >
        {item.url ? <Link to={item.url}>{content}</Link> : content}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function NavMain() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { addFolder } = useThreadManagement()
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()
  const { open: projectDialogOpen, setOpen: setProjectDialogOpen } =
    useProjectDialog()
  const navMainItems = getNavMainItems(
    () => setSearchOpen(true),
    () => {
      useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
      navigate({ to: route.home })
    },
    () => {
      useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
      navigate({ to: route.home })
    }
  ).filter(
    // Search moved to the branded header row (Codex-style); agent chat is off.
    (item) =>
      item.title !== 'common:newAgentChat' && item.title !== 'common:search'
  )

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const newProject = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({
      to: '/project/$projectId',
      params: { projectId: newProject.id },
    })
  }

  return (
    <>
      <SidebarMenu>
        {navMainItems.map((item) => {
          if (item.animatedIcon) {
            return (
              <NavMainItemWithAnimatedIcon
                key={item.title}
                item={item}
                label={t(item.title)}
              />
            )
          }

          const Icon = item.icon
          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild={!!item.url}
                isActive={item.isActive}
                onClick={item.onClick}
              >
                {item.url ? (
                  <Link to={item.url}>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{t(item.title)}</span>
                    {item.shortcut}
                  </Link>
                ) : (
                  <>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{t(item.title)}</span>
                    {item.shortcut}
                  </>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>

      <AddProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        editingKey={null}
        onSave={handleCreateProject}
      />

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  )
}
