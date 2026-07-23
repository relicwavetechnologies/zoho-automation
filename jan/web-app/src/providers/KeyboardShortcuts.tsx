import { useKeyboardShortcut } from '@/hooks/useHotkeys'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useAuxiliaryShell } from '@/hooks/useAuxiliaryShell'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAssistantSwitcher } from '@/hooks/useAssistantSwitcher'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

export function KeyboardShortcutsProvider() {
  const { open, setLeftPanel } = useLeftPanel()
  const toggleAuxiliary = useAuxiliaryShell((s) => s.toggle)
  const openSideChat = useAuxiliaryTabs((s) => s.openSideChat)
  const { setOpen: setSearchOpen } = useSearchDialog()
  const { setOpen: setProjectDialogOpen } = useProjectDialog()
  const router = useRouter()

  // Get shortcut specs from centralized configuration
  const sidebarShortcut = PlatformShortcuts[ShortcutAction.TOGGLE_SIDEBAR]
  const auxiliaryShortcut = PlatformShortcuts[ShortcutAction.TOGGLE_AUXILIARY]
  const sideChatShortcut = PlatformShortcuts[ShortcutAction.NEW_SIDE_CHAT]
  const newChatShortcut = PlatformShortcuts[ShortcutAction.NEW_CHAT]
  const newProjectShortcut = PlatformShortcuts[ShortcutAction.NEW_PROJECT]
  const settingsShortcut = PlatformShortcuts[ShortcutAction.GO_TO_SETTINGS]
  const searchShortcut = PlatformShortcuts[ShortcutAction.SEARCH]
  const switchAssistantShortcut =
    PlatformShortcuts[ShortcutAction.SWITCH_ASSISTANT]

  // Toggle Sidebar
  useKeyboardShortcut({
    ...sidebarShortcut,
    callback: () => {
      setLeftPanel(!open)
    },
  })

  // Toggle Auxiliary (right) sidebar
  useKeyboardShortcut({
    ...auxiliaryShortcut,
    callback: () => {
      toggleAuxiliary()
    },
  })

  // New side chat tab
  useKeyboardShortcut({
    ...sideChatShortcut,
    callback: () => {
      openSideChat()
    },
  })

  // New Chat
  useKeyboardShortcut({
    ...newChatShortcut,
    callback: () => {
      useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
      router.navigate({ to: route.home })
    },
  })

  // New Agent Chat — disabled, kept as dead code for future use
  // useKeyboardShortcut({
  //   ...newAgentChatShortcut,
  //   callback: () => {
  //     useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
  //     router.navigate({ to: route.home })
  //   },
  // })

  // New Project
  useKeyboardShortcut({
    ...newProjectShortcut,
    callback: () => {
      setProjectDialogOpen(true)
    },
  })

  // Go to Settings
  useKeyboardShortcut({
    ...settingsShortcut,
    callback: () => {
      router.navigate({ to: route.settings.general })
    },
  })

  // Search
  useKeyboardShortcut({
    ...searchShortcut,
    callback: () => {
      setSearchOpen(true)
    },
  })

  // Switch Assistant — advance to the next assistant on each press
  useKeyboardShortcut({
    ...switchAssistantShortcut,
    callback: () => {
      useAssistantSwitcher.getState().cycleHandler?.()
    },
  })

  // This component doesn't render anything
  return null
}
