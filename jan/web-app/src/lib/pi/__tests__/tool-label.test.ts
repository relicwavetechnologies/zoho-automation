import { describe, it, expect } from 'vitest'
import { resolveToolLabel } from '../tool-label'

describe('resolveToolLabel', () => {
  it('surfaces the gateway op instead of the dispatcher name', () => {
    expect(
      resolveToolLabel({
        type: 'tool-divo_gateway',
        input: { op: 'skills.search', payload: { text: 'finance' } },
      })
    ).toBe('skill search')
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
    ).toBe('connection list')
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
    ).toBe('skill search')
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
    ).toBe('connection list')
  })

  it('reads the tool name from a dynamic-tool part (name not in type)', () => {
    expect(
      resolveToolLabel({
        type: 'dynamic-tool',
        toolName: 'divo_gateway',
        input: { op: 'skills.search' },
      })
    ).toBe('skill search')
  })

  it('surfaces a gateway op even when the tool name has not landed yet', () => {
    // Name still empty, but the op is already on the wire → show the op, not "".
    expect(
      resolveToolLabel({ type: 'tool-', input: '{"op":"skills.list"' })
    ).toBe('skill list')
  })

  it('never leaks a dotted wire op into the label', () => {
    // Rows read "Ran {label}", so "Ran teach.learning.apply" is wire format
    // showing through. Every known op gets a phrase; unknown ops degrade to
    // spaced words rather than dots.
    const label = (op: string) =>
      resolveToolLabel({ type: 'tool-divo_gateway', input: { op } })

    for (const op of [
      'capabilities.get',
      'tools.list',
      'tools.preflight',
      'tools.prepare',
      'tools.commit',
      'skills.list',
      'skills.search',
      'skills.get',
      'persona.resolve',
      'teach.context.get',
      'teach.learning.apply',
      'google.plan',
      'connections.list',
      'media.image_ocr',
      // Not in the map — the generic fallback still has to clean it up.
      'some.brand_new.op',
    ]) {
      expect(label(op)).not.toMatch(/[._]/)
    }

    expect(label('teach.learning.apply')).toBe('teach learning update')
    expect(label('media.image_ocr')).toBe('image OCR')
    expect(label('some.brand_new.op')).toBe('some brand new op')
  })

  it('returns empty only when nothing is known yet', () => {
    expect(resolveToolLabel({ type: 'tool-', input: undefined })).toBe('')
  })
})
