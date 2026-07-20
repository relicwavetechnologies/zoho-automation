import { describe, it, expect } from 'vitest'
import { resolveToolIdentity, resolveToolLabel } from '../tool-label'

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

  it('uses a concise label for the Pi-owned subagent runner', () => {
    expect(resolveToolLabel({ type: 'tool-divo_subagents' })).toBe('subagents')
  })

  it('uses a user-facing label for the Pi-owned task board', () => {
    expect(resolveToolLabel({ type: 'tool-divo_todos' })).toBe('task plan')
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
    // The act, not the technique: the user attached an image and Divo read it.
    expect(label('media.image_ocr')).toBe('read image')
    expect(label('some.brand_new.op')).toBe('some brand new op')
  })

  it('shows the attached filename for an image read, not its normalised path', () => {
    // The desktop rewrites attachments to a long absolute path that fills the
    // row and names nothing the user recognises.
    const identity = resolveToolIdentity({
      type: 'tool-divo_gateway',
      input: {
        op: 'media.image_ocr',
        payload: {
          filePath: '/Users/x/Library/Application Support/divo/att/9f2c/receipt.png',
          mimeType: 'image/png',
        },
      },
    })

    expect(identity.label).toBe('read image')
    expect(identity.detail).toBe('receipt.png')
  })

  it('returns empty only when nothing is known yet', () => {
    expect(resolveToolLabel({ type: 'tool-', input: undefined })).toBe('')
  })
})

describe('resolveToolIdentity — detail', () => {
  const detail = (part: Parameters<typeof resolveToolIdentity>[0]) =>
    resolveToolIdentity(part).detail

  it('surfaces the search query rather than just naming the tool', () => {
    // "Ran web search" tells the user nothing; the query is the information.
    // A tools.invoke dispatch nests args TWO deep — see
    // `toolsInvokePayloadSchema` in advance-backend: { toolId, args }.
    expect(
      detail({
        type: 'tool-divo_gateway',
        input: {
          op: 'tools.invoke',
          payload: {
            toolId: 'webSearch',
            args: { query: 'india payroll compliance' },
          },
        },
      })
    ).toBe('india payroll compliance')
  })

  it('still finds args placed directly on the payload', () => {
    expect(
      detail({
        type: 'tool-divo_gateway',
        input: {
          op: 'tools.invoke',
          payload: { toolId: 'webSearch', query: 'gst filing deadlines' },
        },
      })
    ).toBe('gst filing deadlines')
  })

  it('shows the query while the call is still streaming in', () => {
    expect(
      detail({
        type: 'tool-divo_gateway',
        input: '{"op":"tools.invoke","payload":{"toolId":"webSearch","query":"hr pain points',
      })
    ).toBe('hr pain points')
  })

  it('reduces a file path to its basename for file tools', () => {
    // A row is too narrow for a full path; the tail identifies the file.
    expect(
      detail({ type: 'tool-write', input: { file_path: '/a/b/c/report.html' } })
    ).toBe('report.html')
    expect(
      detail({ type: 'tool-edit', input: { path: '/x/y/main.ts' } })
    ).toBe('main.ts')
  })

  it('keeps a shell command intact — it is not a path', () => {
    expect(
      detail({ type: 'tool-bash', input: { command: 'ls -la /tmp/build' } })
    ).toBe('ls -la /tmp/build')
  })

  it('never surfaces file contents, however the write is shaped', () => {
    // `content` runs to megabytes and is useless truncated to a row.
    expect(
      detail({
        type: 'tool-write',
        input: { content: 'x'.repeat(5_000) },
      })
    ).toBeUndefined()
  })

  it('is absent when the call has no single argument worth naming', () => {
    expect(detail({ type: 'tool-divo_gateway', input: { op: 'skills.list' } }))
      .toBeUndefined()
  })
})
