import { describe, expect, it } from 'vitest'
import {
  enhanceArtifactMarkdown,
  fileLinkLabel,
  isFileMarkdownHref,
  isNumericCitationLabel,
} from '../artifact-markdown'

describe('artifact-markdown', () => {
  it('detects file-like hrefs and not http urls', () => {
    expect(isFileMarkdownHref('jan/src-tauri/src/core/pi/session.rs')).toBe(true)
    expect(isFileMarkdownHref('./manager.rs')).toBe(true)
    expect(isFileMarkdownHref('session.rs')).toBe(true)
    expect(isFileMarkdownHref('https://github.com/raine/claude-history')).toBe(
      false
    )
    expect(isFileMarkdownHref('#artifact-ref-1')).toBe(false)
  })

  it('uses basename for file chip labels', () => {
    expect(fileLinkLabel('jan/src/core/pi/session.rs')).toBe('session.rs')
    expect(fileLinkLabel('path/a.rs', 'session.rs')).toBe('session.rs')
  })

  it('linkifies bare [n] citations when Sources lists urls', () => {
    const input = [
      'We decided on four tabs [1][2].',
      '',
      '## Sources',
      '1. Report A — https://example.com/a',
      '2. https://example.com/b',
      '',
    ].join('\n')

    const out = enhanceArtifactMarkdown(input)
    expect(out).toContain('[1](https://example.com/a)')
    expect(out).toContain('[2](https://example.com/b)')
    expect(out).not.toContain('We decided on four tabs [1][2].')
  })

  it('leaves code fences alone', () => {
    const input = [
      'See `array[1]` and:',
      '```',
      'x[1] = 2',
      '```',
      '',
      '## Sources',
      '1. https://example.com/a',
    ].join('\n')
    const out = enhanceArtifactMarkdown(input)
    expect(out).toContain('`array[1]`')
    expect(out).toContain('x[1] = 2')
  })

  it('recognizes numeric citation labels', () => {
    expect(isNumericCitationLabel('12')).toBe(true)
    expect(isNumericCitationLabel('session.rs')).toBe(false)
  })
})
