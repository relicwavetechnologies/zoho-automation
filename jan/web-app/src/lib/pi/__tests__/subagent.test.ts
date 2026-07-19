import { describe, expect, it } from 'vitest'
import { isDivoSubagentTool, readDivoSubagentDetails } from '../subagent'

describe('Divo subagent tool state', () => {
  it('recognizes static and dynamic Pi tool parts', () => {
    expect(isDivoSubagentTool({ type: 'tool-divo_subagents' })).toBe(true)
    expect(isDivoSubagentTool({ type: 'dynamic-tool', toolName: 'divo_subagents' })).toBe(true)
    expect(isDivoSubagentTool({ type: 'tool-read' })).toBe(false)
  })

  it('uses the stable child ids and lifecycle snapshot from the Pi extension', () => {
    const details = readDivoSubagentDetails({
      toolCallId: 'parent-tool-a',
      output: {
        content: [{ type: 'text', text: 'Subagents: 1/2 completed' }],
        details: {
          version: 1,
          parentToolCallId: 'parent-tool-a',
          mode: 'parallel',
          state: 'running',
          children: [
            {
              id: 'child-a',
              index: 0,
              role: 'scout',
              task: 'Find the runtime',
              state: 'completed',
              activity: { kind: 'complete', label: 'Completed' },
              usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 16, turns: 1 },
              events: [{ seq: 1, at: '2026-07-19T00:00:00.000Z', kind: 'completed' }],
            },
            {
              id: 'child-b',
              index: 1,
              role: 'reviewer',
              task: 'Review the launch path',
              state: 'running',
              activity: { kind: 'tool', label: 'read runtime.rs' },
              usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 0 },
              events: [],
            },
          ],
        },
      },
    })

    expect(details.parentToolCallId).toBe('parent-tool-a')
    expect(details.summary).toMatchObject({ total: 2, completed: 1, running: 1 })
    expect(details.children.map((child) => child.id)).toEqual(['child-a', 'child-b'])
    expect(details.children[1].activity.label).toBe('read runtime.rs')
  })

  it('shows planned children before Pi emits its first progress snapshot', () => {
    const details = readDivoSubagentDetails({
      toolCallId: 'parent-tool-b',
      input: {
        tasks: [
          { agent: 'scout', task: 'Inspect frontend' },
          { agent: 'planner', task: 'Plan backend changes' },
        ],
      },
    })

    expect(details.mode).toBe('parallel')
    expect(details.summary).toMatchObject({ total: 2, queued: 2 })
    expect(details.children[0]).toMatchObject({
      id: 'parent-tool-b:planned:0',
      role: 'scout',
      task: 'Inspect frontend',
      state: 'queued',
    })
  })
})
