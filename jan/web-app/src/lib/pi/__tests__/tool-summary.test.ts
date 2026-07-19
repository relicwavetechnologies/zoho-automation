import { describe, it, expect } from 'vitest'
import { summarizeBurst, toolCategory } from '../tool-summary'

const gateway = (op: string, toolId?: string) => ({
  type: 'tool-divo_gateway',
  input: toolId ? { op, payload: { toolId } } : { op },
})

describe('toolCategory', () => {
  it('treats lookups as searches, including list-style ops', () => {
    expect(toolCategory(gateway('skills.search'))).toBe('search')
    expect(toolCategory(gateway('tools.list'))).toBe('search')
    expect(toolCategory(gateway('connections.list'))).toBe('search')
  })

  it('treats reads as files', () => {
    expect(toolCategory({ type: 'tool-readFile' })).toBe('file')
    expect(toolCategory(gateway('media.image_ocr'))).toBe('file')
  })

  it('falls back to command for anything that acts rather than reads', () => {
    expect(toolCategory({ type: 'tool-runCommand' })).toBe('command')
    expect(toolCategory(gateway('tools.invoke', 'zohoBooks'))).toBe('command')
  })
})

describe('summarizeBurst', () => {
  it('reads as one sentence across all three buckets', () => {
    const parts = [
      { type: 'tool-readFile' },
      { type: 'tool-readFile' },
      gateway('skills.search'),
      { type: 'tool-runCommand' },
    ]
    expect(summarizeBurst(parts, false)).toBe(
      'Explored 2 files, 1 search, ran 1 command'
    )
    expect(summarizeBurst(parts, true)).toBe(
      'Exploring 2 files, 1 search, ran 1 command'
    )
  })

  it('says Ran, not Explored, when nothing was read or searched', () => {
    // "Explored , ran 2 commands" is the bug this guards against.
    const parts = [{ type: 'tool-runCommand' }, { type: 'tool-runCommand' }]
    expect(summarizeBurst(parts, false)).toBe('Ran 2 commands')
    expect(summarizeBurst(parts, true)).toBe('Running 2 commands')
  })

  it('keeps singulars and irregular plurals right', () => {
    expect(summarizeBurst([{ type: 'tool-runCommand' }], false)).toBe(
      'Ran 1 command'
    )
    expect(summarizeBurst([{ type: 'tool-readFile' }], false)).toBe(
      'Explored 1 file'
    )
    expect(
      summarizeBurst([gateway('skills.search'), gateway('tools.list')], false)
    ).toBe('Explored 2 searches')
  })
})
