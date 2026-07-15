import { describe, it, expect } from 'vitest'
import { resolveToolLabel } from '../tool-label'

describe('resolveToolLabel', () => {
  it('surfaces the gateway op instead of the dispatcher name', () => {
    expect(
      resolveToolLabel({
        type: 'tool-divo_gateway',
        input: { op: 'skills.search', payload: { text: 'finance' } },
      })
    ).toBe('skills.search')
  })

  it('surfaces the concrete tool for tools.invoke', () => {
    expect(
      resolveToolLabel({
        type: 'tool-divo_gateway',
        input: { op: 'tools.invoke', payload: { toolId: 'zohoBooks' } },
      })
    ).toBe('zoho books')
  })

  it('parses stringified input JSON', () => {
    expect(
      resolveToolLabel({
        type: 'tool-divo_gateway',
        input: JSON.stringify({ op: 'connections.list' }),
      })
    ).toBe('connections.list')
  })

  it('falls back to the gateway name while input is still streaming', () => {
    expect(resolveToolLabel({ type: 'tool-divo_gateway', input: undefined })).toBe(
      'divo gateway'
    )
  })

  it('humanizes a non-dispatcher tool name', () => {
    expect(resolveToolLabel({ type: 'tool-divo_skill_resolve' })).toBe(
      'divo skill resolve'
    )
  })

  it('scrapes op from partial JSON still streaming in', () => {
    // op is the first key on the wire, so it resolves before the payload closes.
    expect(
      resolveToolLabel({
        type: 'tool-divo_gateway',
        input: '{"op":"skills.search","payload":{"text":"fin',
      })
    ).toBe('skills.search')
  })

  it('scrapes toolId from partial tools.invoke input mid-stream', () => {
    expect(
      resolveToolLabel({
        type: 'tool-divo_gateway',
        input: '{"op":"tools.invoke","payload":{"toolId":"zohoBooks","args',
      })
    ).toBe('zoho books')
  })

  it('reads op from a partially-parsed object mid-stream', () => {
    expect(
      resolveToolLabel({
        type: 'tool-divo_gateway',
        input: { op: 'connections.list', payload: {} },
      })
    ).toBe('connections.list')
  })

  it('reads the tool name from a dynamic-tool part (name not in type)', () => {
    expect(
      resolveToolLabel({
        type: 'dynamic-tool',
        toolName: 'divo_gateway',
        input: { op: 'skills.search' },
      })
    ).toBe('skills.search')
  })

  it('surfaces a gateway op even when the tool name has not landed yet', () => {
    // Name still empty, but the op is already on the wire → show the op, not "".
    expect(
      resolveToolLabel({ type: 'tool-', input: '{"op":"skills.list"' })
    ).toBe('skills.list')
  })

  it('returns empty only when nothing is known yet', () => {
    expect(resolveToolLabel({ type: 'tool-', input: undefined })).toBe('')
  })
})
