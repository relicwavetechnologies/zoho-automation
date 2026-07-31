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

describe('summarizeBurst — vendor calls describe themselves', () => {
  const invoke = (toolId: string, nativeTool?: string) => ({
    type: 'tool-divo_gateway',
    input: {
      op: 'tools.invoke',
      payload: { toolId, args: nativeTool ? { nativeTool } : {} },
    },
  })

  it('names who was called and what was asked of them', () => {
    // Every Divo call is a divo_gateway dispatch, so counting them produced
    // "Ran 1 command" for everything. The payload knows better.
    expect(summarizeBurst([invoke('googleDrive', 'search_drive')], true)).toBe(
      'Searching Google Drive'
    )
    expect(summarizeBurst([invoke('googleDrive', 'search_drive')], false)).toBe(
      'Searched Google Drive'
    )
  })

  it('picks a verb that fits the native action', () => {
    const past = (native: string) =>
      summarizeBurst([invoke('googleDrive', native)], false)

    expect(past('describe')).toBe('Checked Google Drive')
    expect(past('create_file')).toBe('Updated Google Drive')
    expect(past('send_message')).toBe('Sent from Google Drive')
    expect(past('delete_file')).toBe('Deleted in Google Drive')
  })

  it('does not let a write verb be swallowed by the read pattern', () => {
    // `create` contains "reat", `update` contains no read verb — this guards
    // the ordering of ACTION_VERBS against a careless edit.
    expect(summarizeBurst([invoke('zohoBooks', 'create')], false)).toBe(
      'Updated Zoho Books'
    )
    expect(summarizeBurst([invoke('zohoBooks', 'update')], false)).toBe(
      'Updated Zoho Books'
    )
  })

  it('falls back to a neutral verb when no action is on the wire', () => {
    expect(summarizeBurst([invoke('googleGmail')], false)).toBe(
      'Used Google Gmail'
    )
  })

  it('groups repeated calls to one vendor into a single phrase', () => {
    expect(
      summarizeBurst(
        [invoke('googleGmail', 'list_messages'), invoke('googleGmail', 'list_messages')],
        false
      )
    ).toBe('Searched Google Gmail')
  })

  it('counts instead when the burst spans several vendors', () => {
    // No single sentence fits, and the folded row's icon stack already shows
    // who was involved.
    expect(
      summarizeBurst([invoke('googleGmail'), invoke('googleDrive')], false)
    ).toBe('Ran 2 commands')
  })

  it('counts when a non-vendor call is mixed in', () => {
    // Guards a real bug: dropping the arg-less identities first made this
    // burst look like pure Zoho and hid the skill search entirely.
    expect(
      summarizeBurst(
        [
          { type: 'tool-divo_gateway', input: { op: 'skills.search' } },
          invoke('zohoBooks'),
        ],
        false
      )
    ).toBe('Explored 1 search, ran 1 command')
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

  it('describes todo bursts instead of Ran N commands', () => {
    const create = {
      type: 'tool-divo_todos',
      input: { action: 'create', tasks: [{ content: 'A' }] },
    }
    const update = {
      type: 'tool-divo_todos',
      input: { action: 'update', id: '#1', status: 'completed' },
    }

    expect(toolCategory(create)).toBe('todo')
    expect(summarizeBurst([create, create, create], false)).toBe('Created todos')
    expect(summarizeBurst([create, create], true)).toBe('Creating todos')
    expect(summarizeBurst([update, update], false)).toBe('Updated todos')
    expect(summarizeBurst([create, update], false)).toBe('Updated todos')
  })

  it('names todos and artifacts in mixed bursts', () => {
    expect(
      summarizeBurst(
        [
          {
            type: 'tool-divo_artifact',
            input: { path: 'artifacts/brief.md' },
          },
          {
            type: 'tool-divo_todos',
            input: { action: 'update', id: '#1', status: 'completed' },
          },
          {
            type: 'tool-divo_todos',
            input: { action: 'update', id: '#2', status: 'completed' },
          },
        ],
        false
      )
    ).toBe('Updated todos, opened 1 artifact')
  })
})
