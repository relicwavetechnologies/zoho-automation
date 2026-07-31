import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ArtifactLinks } from '../ArtifactLinks'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'

vi.mock('@/lib/pi/artifact-fs', () => ({
  readArtifactFileContent: vi.fn(async () => '# Brief\n'),
}))

function artifactMessage(overrides?: Record<string, unknown>) {
  return {
    id: 'm1',
    role: 'assistant' as const,
    parts: [
      {
        type: 'tool-divo_artifact',
        state: 'output-available',
        output: {
          details: {
            version: 2,
            artifactId: 'art-links',
            title: 'Leadership Brief',
            mime: 'text/markdown',
            path: '/ws/artifacts/brief.md',
            updatedAt: '2026-07-22T12:00:00.000Z',
            ...overrides,
          },
        },
      },
      { type: 'text', text: 'Done.' },
    ],
  }
}

describe('ArtifactLinks', () => {
  beforeEach(() => {
    useAuxiliaryTabs.setState({
      tabs: [],
      activeTabId: null,
      openOrder: [],
    })
  })

  it('renders nothing when the message has no artifacts', () => {
    const { container } = render(
      <ArtifactLinks
        message={{ id: 'm0', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('opens the sidebar from disk when a created artifact link is clicked', async () => {
    render(<ArtifactLinks message={artifactMessage() as any} />)

    expect(screen.getByTestId('artifact-links')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Leadership Brief/i }))

    await waitFor(() => {
      const state = useAuxiliaryTabs.getState()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0]).toMatchObject({
        kind: 'artifact',
        artifactId: 'art-links',
        title: 'Leadership Brief',
        path: '/ws/artifacts/brief.md',
        content: '# Brief\n',
      })
      expect(state.activeTabId).toBe(state.tabs[0]?.id)
    })
  })
})
