import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ArtifactSurface } from '../surfaces/ArtifactSurface'
import type { ArtifactTab } from '@/lib/auxiliary/types'

vi.mock('@/containers/RenderMarkdown', () => ({
  RenderMarkdown: ({ content }: { content: string }) => (
    <div data-testid="md-preview">{content}</div>
  ),
}))

vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => (
    <pre data-testid="md-source">{code}</pre>
  ),
}))

function markdownTab(content: string): ArtifactTab {
  return {
    id: 'tab-1',
    kind: 'artifact',
    artifactId: 'art-1',
    title: 'Report',
    content,
    mime: 'text/markdown',
    path: '/ws/artifacts/report.md',
    createdAt: Date.now(),
  }
}

describe('ArtifactSurface', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies the raw artifact body from the toolbar', async () => {
    const content = '# Hello\n\nBody with [1] cite.\n'
    render(<ArtifactSurface tab={markdownTab(content)} />)

    fireEvent.click(screen.getByRole('button', { name: /copy artifact/i }))
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(content)
    })
    expect(
      await screen.findByRole('button', { name: /copied artifact/i })
    ).toBeInTheDocument()
  })

  it('enhances bare citations in preview markdown', () => {
    const content = [
      'Finding [1].',
      '',
      '## Sources',
      '1. https://example.com/one',
    ].join('\n')
    render(<ArtifactSurface tab={markdownTab(content)} />)
    expect(screen.getByTestId('md-preview').textContent).toContain(
      '[1](https://example.com/one)'
    )
  })
})
