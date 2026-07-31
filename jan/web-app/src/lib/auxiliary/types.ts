/**
 * Auxiliary Surface tab model.
 *
 * Shell (open/width) and Tab Host (tabs[]) stay kind-agnostic.
 * New surfaces = new kind + renderer; never special-case in the shell.
 */

export type AuxiliaryTabKind = 'artifact' | 'sideChat'

export type AuxiliaryTabBase = {
  id: string
  title: string
  createdAt: number
  /** Main chat thread that opened this tab, if any. */
  originThreadId?: string
}

export type ArtifactMime = 'text/html' | 'text/markdown' | 'text/plain' | 'image/svg+xml'

export type ArtifactTab = AuxiliaryTabBase & {
  kind: 'artifact'
  artifactId: string
  /** Workspace path when this tab is backed by a real file. */
  path?: string
  /** Cached file body (or inline HTML for chat-embedded artifacts). */
  content: string
  mime: ArtifactMime
  language?: string
  version?: number
}

export type SideChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export type SideChatTab = AuxiliaryTabBase & {
  kind: 'sideChat'
  threadId: string
  parentThreadId?: string
  messages: SideChatMessage[]
}

export type AuxiliaryTab = ArtifactTab | SideChatTab

export type OpenArtifactInput = {
  title: string
  content: string
  mime?: ArtifactMime
  language?: string
  artifactId?: string
  /** When set, tab is keyed/refreshed by this workspace path. */
  path?: string
  originThreadId?: string
  version?: number
}

export type OpenSideChatInput = {
  title?: string
  parentThreadId?: string
  originThreadId?: string
  threadId?: string
  initialMessage?: string
}
