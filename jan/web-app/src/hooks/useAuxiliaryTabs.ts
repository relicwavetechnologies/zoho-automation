import { create } from 'zustand'
import { ulid } from 'ulidx'
import type {
  ArtifactTab,
  AuxiliaryTab,
  OpenArtifactInput,
  OpenSideChatInput,
  SideChatMessage,
  SideChatTab,
} from '@/lib/auxiliary/types'
import { useAuxiliaryShell } from '@/hooks/useAuxiliaryShell'

const MAX_TABS = 8

function pathsMatch(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const left = norm(a)
  const right = norm(b)
  if (left === right) return true
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

type AuxiliaryTabsState = {
  tabs: AuxiliaryTab[]
  activeTabId: string | null
  openArtifact: (input: OpenArtifactInput) => string
  openSideChat: (input?: OpenSideChatInput) => string
  focusTab: (id: string) => void
  closeTab: (id: string) => void
  closeAll: () => void
  appendSideChatMessage: (
    tabId: string,
    message: Omit<SideChatMessage, 'id' | 'createdAt'> & {
      id?: string
      createdAt?: number
    }
  ) => void
  getActiveTab: () => AuxiliaryTab | null
}

function ensureShellOpen() {
  useAuxiliaryShell.getState().setOpen(true)
}

function trimTabs(tabs: AuxiliaryTab[], keepId: string): AuxiliaryTab[] {
  if (tabs.length <= MAX_TABS) return tabs
  const keep = tabs.find((t) => t.id === keepId)
  const rest = tabs.filter((t) => t.id !== keepId)
  const trimmed = rest.slice(-(MAX_TABS - 1))
  return keep ? [...trimmed, keep] : trimmed.slice(-MAX_TABS)
}

function nextActiveAfterClose(
  tabs: AuxiliaryTab[],
  closedId: string,
  prevActive: string | null
): string | null {
  if (prevActive !== closedId) {
    return tabs.some((t) => t.id === prevActive) ? prevActive : tabs.at(-1)?.id ?? null
  }
  const index = tabs.findIndex((t) => t.id === closedId)
  if (index < 0) return tabs.at(-1)?.id ?? null
  const remaining = tabs.filter((t) => t.id !== closedId)
  if (remaining.length === 0) return null
  return remaining[Math.min(index, remaining.length - 1)]?.id ?? null
}

export const useAuxiliaryTabs = create<AuxiliaryTabsState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openArtifact: (input) => {
    const path = input.path?.trim() || undefined
    const artifactId = input.artifactId ?? path ?? ulid()
    const existing = get().tabs.find((t): t is ArtifactTab => {
      if (t.kind !== 'artifact') return false
      if (t.artifactId === artifactId) return true
      if (path && t.path && pathsMatch(t.path, path)) return true
      return false
    })
    if (existing) {
      ensureShellOpen()
      set((state) => ({
        activeTabId: existing.id,
        tabs: state.tabs.map((tab) =>
          tab.id === existing.id && tab.kind === 'artifact'
            ? {
                ...tab,
                artifactId:
                  input.artifactId?.trim() || tab.artifactId,
                title: input.title.trim() || tab.title,
                content: input.content,
                path: path ?? tab.path,
                mime: input.mime ?? tab.mime,
                language: input.language ?? tab.language,
                version: (tab.version ?? 1) + 1,
                originThreadId: input.originThreadId ?? tab.originThreadId,
              }
            : tab
        ),
      }))
      return existing.id
    }

    const tab: ArtifactTab = {
      id: ulid(),
      kind: 'artifact',
      title: input.title.trim() || 'Artifact',
      createdAt: Date.now(),
      originThreadId: input.originThreadId,
      artifactId,
      path,
      content: input.content,
      mime: input.mime ?? 'text/markdown',
      language: input.language,
      version: input.version ?? 1,
    }

    ensureShellOpen()
    set((state) => {
      const tabs = trimTabs([...state.tabs, tab], tab.id)
      return { tabs, activeTabId: tab.id }
    })
    return tab.id
  },

  openSideChat: (input = {}) => {
    const threadId = input.threadId ?? ulid()
    const existing = get().tabs.find(
      (t): t is SideChatTab => t.kind === 'sideChat' && t.threadId === threadId
    )
    if (existing) {
      ensureShellOpen()
      set({ activeTabId: existing.id })
      return existing.id
    }

    const seed: SideChatMessage[] = input.initialMessage
      ? [
          {
            id: ulid(),
            role: 'user',
            content: input.initialMessage,
            createdAt: Date.now(),
          },
        ]
      : []

    const tab: SideChatTab = {
      id: ulid(),
      kind: 'sideChat',
      title: input.title?.trim() || 'Side chat',
      createdAt: Date.now(),
      originThreadId: input.originThreadId,
      parentThreadId: input.parentThreadId ?? input.originThreadId,
      threadId,
      messages: seed,
    }

    ensureShellOpen()
    set((state) => {
      const tabs = trimTabs([...state.tabs, tab], tab.id)
      return { tabs, activeTabId: tab.id }
    })
    return tab.id
  },

  focusTab: (id) => {
    if (!get().tabs.some((t) => t.id === id)) return
    ensureShellOpen()
    set({ activeTabId: id })
  },

  closeTab: (id) => {
    set((state) => {
      const nextActive = nextActiveAfterClose(state.tabs, id, state.activeTabId)
      return {
        tabs: state.tabs.filter((t) => t.id !== id),
        activeTabId: nextActive,
      }
    })
  },

  closeAll: () => set({ tabs: [], activeTabId: null }),

  appendSideChatMessage: (tabId, message) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'sideChat') return tab
        const next: SideChatMessage = {
          id: message.id ?? ulid(),
          role: message.role,
          content: message.content,
          createdAt: message.createdAt ?? Date.now(),
        }
        return { ...tab, messages: [...tab.messages, next] }
      }),
    }))
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get()
    if (!activeTabId) return null
    return tabs.find((t) => t.id === activeTabId) ?? null
  },
}))
