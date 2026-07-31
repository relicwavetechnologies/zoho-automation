import { describe, expect, it } from 'vitest'
import {
  currentDivoTodoItem,
  latestDivoTodoDetails,
  latestDivoTodoDetailsForThread,
  readDivoTodoDetails,
} from '../todo'

const board = (revision: number, items: unknown[] = []) => ({
  details: {
    version: 1,
    boardId: 'board-a',
    revision,
    items,
    updatedAt: '2026-07-19T18:00:00.000Z',
  },
})

describe('Divo todo state', () => {
  it('recognizes and normalizes a bounded Pi tool snapshot', () => {
    const details = readDivoTodoDetails({
      type: 'tool-divo_todos',
      output: board(2, [{
        id: 't1',
        content: 'Compare TTS vendors',
        description: 'Use current pricing and latency.',
        activeForm: 'Comparing TTS vendors',
        status: 'in_progress',
        blockedBy: ['research'],
      }]),
    })

    expect(details).toMatchObject({ boardId: 'board-a', revision: 2 })
    expect(currentDivoTodoItem(details!)).toMatchObject({ id: 't1', status: 'in_progress' })
  })

  it('rejects malformed snapshots and non-Divo tools', () => {
    expect(readDivoTodoDetails({ type: 'tool-divo_todos', output: { details: { version: 2 } } })).toBeUndefined()
    expect(readDivoTodoDetails({ type: 'tool-read', output: board(1) })).toBeUndefined()
  })

  it('uses the latest non-stale snapshot from the owning message sequence', () => {
    const messages: any[] = [{
      role: 'assistant',
      parts: [
        { type: 'tool-divo_todos', output: board(3, [{ id: 'done', content: 'Research', status: 'completed' }]) },
        { type: 'tool-divo_todos', output: board(2, [{ id: 'stale', content: 'Ignore', status: 'pending' }]) },
      ],
    }, {
      role: 'assistant',
      parts: [{
        type: 'tool-divo_todos',
        output: board(4, [{ id: 'active', content: 'Draft answer', status: 'in_progress' }]),
      }],
    }]

    expect(latestDivoTodoDetails(messages as any)).toMatchObject({
      revision: 4,
      items: [{ id: 'active' }],
    })
  })

  it('allows a later board to replace an earlier completed board', () => {
    const messages: any[] = [{
      role: 'assistant',
      parts: [{ type: 'tool-divo_todos', output: board(9) }],
    }, {
      role: 'assistant',
      parts: [{
        type: 'tool-divo_todos',
        output: {
          details: {
            version: 1,
            boardId: 'board-b',
            revision: 0,
            items: [{ id: 'next', content: 'New plan', status: 'pending' }],
          },
        },
      }],
    }]

    expect(latestDivoTodoDetails(messages as any)).toMatchObject({ boardId: 'board-b', revision: 0 })
  })

  it('reads only the selected message branch, never a sibling branch task board', () => {
    const toolCall = (boardId: string, task: string) => ({
      type: 'tool_call',
      tool_name: 'divo_todos',
      tool_call_id: `call-${boardId}`,
      input: {},
      output: {
        details: {
          version: 1,
          boardId,
          revision: 1,
          items: [{ id: `task-${boardId}`, content: task, status: 'in_progress' }],
        },
      },
    })
    const messages = [
      {
        id: 'root',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'Research this', annotations: [] } }],
        metadata: { parentId: null, activeChildId: 'branch-a' },
      },
      {
        id: 'branch-a',
        role: 'assistant',
        created_at: 2,
        content: [toolCall('board-a', 'Research active branch')],
        metadata: { parentId: 'root' },
      },
      {
        id: 'branch-b',
        role: 'assistant',
        created_at: 3,
        content: [toolCall('board-b', 'Leaked sibling branch')],
        metadata: { parentId: 'root' },
      },
    ]

    expect(latestDivoTodoDetailsForThread(messages as any)).toMatchObject({
      boardId: 'board-a',
      items: [{ content: 'Research active branch' }],
    })
  })
})
