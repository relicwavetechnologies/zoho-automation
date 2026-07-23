import type { AuxiliaryTabKind } from './types'

export type AuxiliaryLauncherItem = {
  kind: AuxiliaryTabKind | 'comingSoon'
  id: string
  label: string
  description: string
  shortcut?: string
  enabled: boolean
}

/** Empty-rail launcher. Enabled kinds open tabs; others are placeholders. */
export const AUXILIARY_LAUNCHER: AuxiliaryLauncherItem[] = [
  {
    kind: 'sideChat',
    id: 'side-chat',
    label: 'Side chat',
    description: 'Ask a tangent without leaving the main thread',
    shortcut: '⌥S',
    enabled: true,
  },
  {
    kind: 'artifact',
    id: 'demo-artifact',
    label: 'New artifact',
    description: 'Open a research-style report surface',
    shortcut: '⌘⇧A',
    enabled: true,
  },
  {
    kind: 'comingSoon',
    id: 'browser',
    label: 'Browser',
    description: 'Embedded browsing — coming soon',
    enabled: false,
  },
  {
    kind: 'comingSoon',
    id: 'files',
    label: 'Files',
    description: 'Workspace files — coming soon',
    enabled: false,
  },
]

export function tabKindLabel(kind: AuxiliaryTabKind): string {
  switch (kind) {
    case 'artifact':
      return 'Artifact'
    case 'sideChat':
      return 'Side chat'
  }
}
