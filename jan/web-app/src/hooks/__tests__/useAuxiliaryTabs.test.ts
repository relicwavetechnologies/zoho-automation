import { beforeEach, describe, expect, it } from 'vitest'
import { useAuxiliaryShell } from '../useAuxiliaryShell'
import { useAuxiliaryTabs } from '../useAuxiliaryTabs'

describe('useAuxiliaryTabs', () => {
  beforeEach(() => {
    useAuxiliaryTabs.setState({ tabs: [], activeTabId: null })
    useAuxiliaryShell.setState({ open: false, sizePercent: 38 })
  })

  it('opens an artifact tab and focuses the shell', () => {
    const id = useAuxiliaryTabs.getState().openArtifact({
      title: 'Report',
      content: '# hi',
      mime: 'text/markdown',
      artifactId: 'art-1',
    })

    const state = useAuxiliaryTabs.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(id)
    expect(state.tabs[0]?.kind).toBe('artifact')
    expect(useAuxiliaryShell.getState().open).toBe(true)
  })

  it('reuses an existing artifact by artifactId or path and updates content in place', () => {
    const first = useAuxiliaryTabs.getState().openArtifact({
      title: 'A',
      content: 'one',
      artifactId: 'same',
      path: '/ws/artifacts/a.md',
    })
    const second = useAuxiliaryTabs.getState().openArtifact({
      title: 'B',
      content: 'two',
      path: '/ws/artifacts/a.md',
    })

    expect(second).toBe(first)
    expect(useAuxiliaryTabs.getState().tabs).toHaveLength(1)
    const tab = useAuxiliaryTabs.getState().tabs[0]
    expect(tab?.kind).toBe('artifact')
    if (tab?.kind === 'artifact') {
      expect(tab.title).toBe('B')
      expect(tab.content).toBe('two')
      expect(tab.path).toBe('/ws/artifacts/a.md')
      expect(tab.version).toBe(2)
    }
  })

  it('opens side chats and appends messages', () => {
    const id = useAuxiliaryTabs.getState().openSideChat({ title: 'Tangent' })
    useAuxiliaryTabs.getState().appendSideChatMessage(id, {
      role: 'user',
      content: 'hello',
    })

    const tab = useAuxiliaryTabs.getState().tabs[0]
    expect(tab?.kind).toBe('sideChat')
    if (tab?.kind === 'sideChat') {
      expect(tab.messages).toHaveLength(1)
      expect(tab.messages[0]?.content).toBe('hello')
    }
  })

  it('closes the active tab and focuses a neighbor', () => {
    const a = useAuxiliaryTabs.getState().openSideChat({ title: 'A' })
    const b = useAuxiliaryTabs.getState().openSideChat({ title: 'B' })
    expect(useAuxiliaryTabs.getState().activeTabId).toBe(b)

    useAuxiliaryTabs.getState().closeTab(b)
    expect(useAuxiliaryTabs.getState().activeTabId).toBe(a)
    expect(useAuxiliaryTabs.getState().tabs).toHaveLength(1)
  })
})
