import { describe, it, expect } from 'vitest'
import { describeSubagentEvent, summarizeSubagentTask } from '../subagent-event'

const event = (kind: string, label?: string, seq = 1) => ({ seq, at: '', kind, label })

describe('describeSubagentEvent', () => {
  it('turns a raw gateway call into the work log vocabulary', () => {
    // This is verbatim what Pi puts in the label. Printed as-is it wraps onto
    // two lines of JSON in a 13px row.
    const view = describeSubagentEvent(
      event(
        'tool',
        'divo_gateway {"op":"tools.invoke","payload":{"toolId":"googleGmail","args":{"op":"describe","nativeTool":"search_gmail_messages"}}}'
      )
    )

    expect(view.kind).toBe('tool')
    if (view.kind !== 'tool') throw new Error('expected a tool view')
    expect(view.identity.label).toBe('google gmail')
    expect(view.identity.detail).toBe('search gmail messages')
    expect(view.identity.toolId).toBe('googleGmail')
  })

  it('still names the tool when the argument was truncated mid-object', () => {
    // The event budget upstream cuts long calls. A strict parse would discard
    // exactly the interesting ones.
    const view = describeSubagentEvent(
      event('tool', 'divo_gateway {"op":"tools.invoke","payload":{"toolId":"zohoBooks","args":{"op":"lis')
    )

    expect(view.kind).toBe('tool')
    if (view.kind !== 'tool') throw new Error('expected a tool view')
    expect(view.identity.label).toBe('zoho books')
  })

  it('handles a bare tool name with no argument', () => {
    // The result half of a call arrives as just the tool name.
    const view = describeSubagentEvent(event('tool_result', 'divo_gateway'))
    expect(view.kind).toBe('tool')
  })

  it('leaves lifecycle notes as plain text', () => {
    for (const label of ['Queued', 'Started', 'Thinking', 'Produced an update']) {
      const view = describeSubagentEvent(event('update', label))
      expect(view).toEqual({ kind: 'note', text: label })
    }
  })

  it('falls back to the humanised kind when there is no label', () => {
    expect(describeSubagentEvent(event('tool_result'))).toEqual({
      kind: 'note',
      text: 'tool result',
    })
  })

  it('does not mistake a prose label for a tool call', () => {
    // Multi-word labels are notes; a tool name never contains a space.
    const view = describeSubagentEvent(event('update', 'Waiting on approval'))
    expect(view.kind).toBe('note')
  })
})

describe('summarizeSubagentTask', () => {
  it('flattens a markdown brief to one readable line', () => {
    const task = [
      '## Task: Check Gmail inbox (end-to-end)',
      '',
      "Use the **Divo gateway** to check the user's inbox.",
      '1. First resolve the `connection`',
      '2. Then search',
    ].join('\n')

    expect(summarizeSubagentTask(task)).toBe(
      "Task: Check Gmail inbox (end-to-end) Use the Divo gateway to check the user's inbox. First resolve the connection Then search"
    )
  })

  it('drops fenced code rather than inlining it', () => {
    expect(summarizeSubagentTask('Run this:\n```js\nconst a = 1\n```\nthen report')).toBe(
      'Run this: then report'
    )
  })

  it('keeps link text and drops the target', () => {
    expect(summarizeSubagentTask('See [the spec](https://example.com/x) first')).toBe(
      'See the spec first'
    )
  })

  it('leaves plain prose untouched', () => {
    expect(summarizeSubagentTask('Get a Zoho Books financial brief')).toBe(
      'Get a Zoho Books financial brief'
    )
  })
})
