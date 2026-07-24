import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MarkdownLink } from '../MarkdownLink'

describe('MarkdownLink', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders http links with a label', () => {
    render(
      <MarkdownLink href="https://github.com/raine/claude-history">
        raine/claude-history
      </MarkdownLink>
    )
    const link = screen.getByRole('link', { name: /raine\/claude-history/i })
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/raine/claude-history'
    )
    expect(link).toHaveClass('markdown-link')
  })

  it('renders path hrefs as file chips and copies on click', () => {
    render(
      <MarkdownLink href="jan/src-tauri/src/core/pi/session.rs">
        session.rs
      </MarkdownLink>
    )
    const link = screen.getByRole('link', { name: /session\.rs/i })
    expect(link).toHaveClass('markdown-file-link')
    fireEvent.click(link)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'jan/src-tauri/src/core/pi/session.rs'
    )
  })

  it('renders numeric citation labels as pills', () => {
    render(<MarkdownLink href="https://example.com/a">1</MarkdownLink>)
    const link = screen.getByRole('link', { name: '1' })
    expect(link).toHaveClass('markdown-citation-pill')
  })
})
