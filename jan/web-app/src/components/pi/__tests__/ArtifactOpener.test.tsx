import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ArtifactOpener } from '../ArtifactOpener'
import { useAuxiliaryShell } from '@/hooks/useAuxiliaryShell'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'

vi.mock('@/lib/pi/artifact-fs', () => ({
  readArtifactFileContent: vi.fn(async (path: string) => {
    if (path.includes('brief.md')) return '# Findings\n\nLong writeup.\n'
    if (path.includes('v2')) return 'v2 revised'
    return `content-for:${path}`
  }),
}))

function artifactThreadMessage(path: string, updatedAt: string, title = 'Research Brief') {
  return {
    id: 'assistant-1',
    role: 'assistant',
    created_at: 2,
    content: [
      {
        type: 'tool_call',
        tool_name: 'divo_artifact',
        tool_call_id: 'call-art-1',
        input: { path, title },
        output: {
          details: {
            version: 2,
            artifactId: 'art-smoke',
            title,
            mime: 'text/markdown',
            path,
            summaryForChat: 'Full brief is in the sidebar.',
            updatedAt,
          },
        },
      },
    ],
    metadata: { parentId: 'user-1' },
  }
}

describe('ArtifactOpener', () => {
  beforeEach(() => {
    useAuxiliaryTabs.setState({ tabs: [], activeTabId: null })
    useAuxiliaryShell.setState({ open: false, sizePercent: 38 })
  })

  it('opens the auxiliary rail from a path badge by reading the file', async () => {
    const messages = [
      {
        id: 'user-1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'Write a research brief', annotations: [] } }],
        metadata: { parentId: null, activeChildId: 'assistant-1' },
      },
      artifactThreadMessage('/ws/artifacts/brief.md', '2026-07-22T12:00:00.000Z'),
    ] as any

    render(<ArtifactOpener messages={messages} />)

    await waitFor(() => {
      expect(useAuxiliaryShell.getState().open).toBe(true)
    })
    const tab = useAuxiliaryTabs.getState().tabs[0]
    expect(tab?.kind).toBe('artifact')
    if (tab?.kind === 'artifact') {
      expect(tab.artifactId).toBe('art-smoke')
      expect(tab.title).toBe('Research Brief')
      expect(tab.path).toBe('/ws/artifacts/brief.md')
      expect(tab.content).toContain('Long writeup')
    }
  })

  it('updates an existing artifact tab in place on a newer badge', async () => {
    const first = [
      {
        id: 'user-1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'Write a research brief', annotations: [] } }],
        metadata: { parentId: null, activeChildId: 'assistant-1' },
      },
      artifactThreadMessage('/ws/artifacts/brief.md', '2026-07-22T12:00:00.000Z'),
    ] as any

    const { rerender } = render(<ArtifactOpener messages={first} />)
    await waitFor(() => {
      expect(useAuxiliaryTabs.getState().tabs).toHaveLength(1)
    })

    const second = [
      first[0],
      {
        ...artifactThreadMessage(
          '/ws/artifacts/v2.md',
          '2026-07-22T13:00:00.000Z',
          'Research Brief'
        ),
        id: 'assistant-2',
        metadata: { parentId: 'user-1' },
      },
    ] as any
    second[0] = {
      ...second[0],
      metadata: { parentId: null, activeChildId: 'assistant-2' },
    }

    rerender(<ArtifactOpener messages={second} />)

    await waitFor(() => {
      const tab = useAuxiliaryTabs.getState().tabs[0]
      expect(tab?.kind).toBe('artifact')
      if (tab?.kind === 'artifact') {
        expect(tab.content).toBe('v2 revised')
        expect(tab.version).toBe(2)
      }
    })
  })

  it('does nothing for ordinary chat with no artifact tool', () => {
    render(
      <ArtifactOpener
        messages={
          [
            {
              id: 'user-1',
              role: 'user',
              created_at: 1,
              content: [{ type: 'text', text: { value: 'Hi', annotations: [] } }],
              metadata: { parentId: null, activeChildId: 'assistant-1' },
            },
            {
              id: 'assistant-1',
              role: 'assistant',
              created_at: 2,
              content: [{ type: 'text', text: { value: 'Hello!', annotations: [] } }],
              metadata: { parentId: 'user-1' },
            },
          ] as any
        }
      />
    )
    expect(useAuxiliaryShell.getState().open).toBe(false)
    expect(useAuxiliaryTabs.getState().tabs).toHaveLength(0)
  })
})
