import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ArtifactFileRefresh } from '../ArtifactFileRefresh'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'

vi.mock('@/lib/pi/artifact-fs', () => ({
  readArtifactFileContent: vi.fn(async () => '# refreshed\n'),
}))

describe('ArtifactFileRefresh', () => {
  beforeEach(() => {
    useAuxiliaryTabs.setState({ tabs: [], activeTabId: null })
  })

  it('reloads an open artifact tab when edit completes on the same path', async () => {
    useAuxiliaryTabs.getState().openArtifact({
      artifactId: 'art-1',
      title: 'Brief',
      content: '# old\n',
      mime: 'text/markdown',
      path: '/ws/artifacts/brief.md',
    })

    const messages = [
      {
        id: 'user-1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'remove a line', annotations: [] } }],
        metadata: { parentId: null, activeChildId: 'assistant-1' },
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        created_at: 2,
        content: [
          {
            type: 'tool_call',
            tool_name: 'edit',
            tool_call_id: 'call-edit-1',
            input: {
              path: '/ws/artifacts/brief.md',
              edits: [{ oldText: 'x', newText: '' }],
            },
            output: { details: { diff: '...' } },
          },
        ],
        metadata: { parentId: 'user-1' },
      },
    ] as any

    render(<ArtifactFileRefresh messages={messages} />)

    await waitFor(() => {
      const tab = useAuxiliaryTabs.getState().tabs[0]
      expect(tab?.kind).toBe('artifact')
      if (tab?.kind === 'artifact') {
        expect(tab.content).toBe('# refreshed\n')
        expect(tab.version).toBe(2)
      }
    })
  })
})
