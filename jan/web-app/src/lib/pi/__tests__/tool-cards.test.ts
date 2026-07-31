import { describe, expect, it } from 'vitest'
import { resolveToolIdentity } from '../tool-label'
import { extractInvokeArgs } from '../tool-cards/invoke-args'
import { detectCount, normalizeToolOutput } from '../tool-cards/output'
import { summarizeToolResult } from '../tool-cards/result'
import { isVendorCard, resolveToolCardModel } from '../tool-cards/vendors'
import { extractCommand, isTerminalTool, parseTerminalOutput } from '../tool-cards/terminal'

/** A Google `tools.invoke` part: op/nativeTool at args level, params in args.input. */
function gPart(
  toolId: string,
  nativeTool: string,
  opts: { mode?: 'call' | 'describe'; input?: Record<string, unknown> } = {}
) {
  return {
    type: 'tool-divo_gateway',
    input: {
      op: 'tools.invoke',
      payload: {
        toolId,
        args: { op: opts.mode ?? 'call', nativeTool, input: opts.input ?? {} },
      },
    },
  }
}

/** A flat (Lark/Zoho) part: operation in args.op, params beside it. */
function flatPart(toolId: string, op: string, fields: Record<string, unknown> = {}) {
  return {
    type: 'tool-divo_gateway',
    input: { op: 'tools.invoke', payload: { toolId, args: { op, ...fields } } },
  }
}

const mcp = (text: string) => ({ content: [{ type: 'text', text }] })

describe('extractInvokeArgs', () => {
  it('exposes the nested native input for a Google call', () => {
    const args = extractInvokeArgs(gPart('googleGmail', 'search_gmail_messages', { input: { query: 'x' } }).input)
    expect(args).toMatchObject({ nativeTool: 'search_gmail_messages', input: { query: 'x' } })
  })

  it('returns null for a partial (still-streaming) string', () => {
    expect(extractInvokeArgs('{"op":"tools.invoke","payload":{"args":{"nat')).toBeNull()
  })
})

describe('normalizeToolOutput / detectCount', () => {
  it('flattens an MCP content array and reads a lead-verb count', () => {
    const out = normalizeToolOutput(mcp('Found 3 messages'))
    expect(out.text).toBe('Found 3 messages')
    expect(detectCount(out.text)).toBe(3)
  })

  it('ignores a bare year in a date', () => {
    expect(detectCount('Message received on 2024-01-05')).toBeUndefined()
  })
})

describe('summarizeToolResult', () => {
  it('headlines a count and lists the items, skipping the count header', () => {
    const out = normalizeToolOutput(mcp('Found 2 messages\n- Invoice #1 from Acme\n- Invoice #2 from Acme'))
    const s = summarizeToolResult(out, { countNoun: 'message', action: 'search' })
    expect(s.headline).toBe('2 messages')
    expect(s.items).toEqual(['Invoice #1 from Acme', 'Invoice #2 from Acme'])
  })

  it('returns all items (up to the cap) so the card can expand them inline', () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ summary: `Task ${i + 1}`, status: 'open' }))
    const out = normalizeToolOutput({ tasks })
    const s = summarizeToolResult(out, { countNoun: 'task' })
    expect(s.headline).toBe('9 tasks')
    expect(s.items).toHaveLength(9)
    expect(s.items?.[8]).toBe('Task 9')
    expect(s.moreCount).toBeUndefined()
  })

  it('caps a huge array and reports the overflow for the raw view', () => {
    const tasks = Array.from({ length: 80 }, (_, i) => ({ summary: `Task ${i + 1}` }))
    const s = summarizeToolResult(normalizeToolOutput({ tasks }), { countNoun: 'task' })
    expect(s.items).toHaveLength(50)
    expect(s.moreCount).toBe(30)
  })

  it('renders spreadsheet rows by joining their cells', () => {
    const out = normalizeToolOutput({ values: [['Alice', 30, 'NY'], ['Bob', 25, 'LA']] })
    const s = summarizeToolResult(out, {})
    expect(s.items).toEqual(['Alice · 30 · NY', 'Bob · 25 · LA'])
  })

  it('surfaces a created object title and openable link for a write', () => {
    const out = normalizeToolOutput({
      spreadsheetId: 'abc',
      title: 'Q3 Budget',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc',
    })
    const s = summarizeToolResult(out, { action: 'create' })
    expect(s.headline).toBe('“Q3 Budget”')
    expect(s.link).toBe('https://docs.google.com/spreadsheets/d/abc')
  })

  it('flags an error envelope', () => {
    const out = normalizeToolOutput('Request rejected (bad_args).\n\nMissing spreadsheet id')
    const s = summarizeToolResult(out)
    expect(s.failed).toBe(true)
    expect(s.message).toBe('Missing spreadsheet id')
  })
})

describe('resolveToolCardModel', () => {
  it('reads a Gmail search subject from the nested input and counts the result', () => {
    const part = gPart('googleGmail', 'search_gmail_messages', { input: { query: 'invoice' } })
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    expect(model.appName).toBe('Gmail')
    expect(model.verb.past).toBe('Searched')
    expect(model.subject).toBe('invoice')
    expect(model.describe).toBe(false)
    expect(model.buildSummary(normalizeToolOutput(mcp('Found 5 messages'))).headline).toBe('5 messages')
  })

  it('labels a describe call as preparation, not the action', () => {
    const part = gPart('googleSheets', 'create_spreadsheet', { mode: 'describe' })
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    expect(model.describe).toBe(true)
    expect(model.verb.past).toBe('Prepared')
    expect(model.subject).toBe('create spreadsheet')
    // A describe performed no action, so it summarizes to nothing.
    expect(model.buildSummary(normalizeToolOutput(mcp('{...schema...}')))).toEqual({})
  })

  it('counts appended rows from the request, not the response', () => {
    const part = gPart('googleSheets', 'append_table_rows', {
      input: { sheet_name: 'Sheet1', range: 'A1:C', rows: [[1], [2], [3]] },
    })
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    expect(model.verb.past).toBe('Appended rows')
    expect(model.subject).toBe('Sheet1!A1:C')
    expect(model.buildSummary(normalizeToolOutput('')).headline).toBe('3 rows')
  })

  it('cards a flat Lark call and reads its op as the operation', () => {
    const part = flatPart('larkDoc', 'get', { title: 'Roadmap', document_id: 'doccnXYZ' })
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    expect(model.appName).toBe('Lark Docs')
    expect(model.verb.past).toBe('Read')
    expect(model.subject).toBe('Roadmap')
  })

  it('gives an unmapped vendor op an inferred verb and generic subject', () => {
    const part = flatPart('zohoBooks', 'get_purchase_order', { po_number: 'PO-99' })
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    expect(model.appName).toBe('Zoho Books')
    expect(model.verb.past).toBe('Read')
  })

  it('cards a flat single-op web search (no op field) via the default descriptor', () => {
    const part = {
      type: 'tool-divo_gateway',
      input: { op: 'tools.invoke', payload: { toolId: 'webSearch', args: { query: 'best crm 2026', limit: 5 } } },
    }
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    expect(model.appName).toBe('Web Search')
    expect(model.verb.past).toBe('Searched the web')
    expect(model.subject).toBe('best crm 2026')
  })

  it('cards an operation-keyed Semrush call', () => {
    const part = flatPart('semrush', 'domain_overview', { domain: 'acme.com' })
    // Semrush keys on `operation`, not `op` — the resolver still finds it.
    const p2 = { type: 'tool-divo_gateway', input: { op: 'tools.invoke', payload: { toolId: 'semrush', args: { operation: 'domain_overview', domain: 'acme.com' } } } }
    const model = resolveToolCardModel(resolveToolIdentity(p2), p2.input)!
    expect(model.appName).toBe('Semrush')
    expect(model.verb.past).toBe('Analysed')
    expect(model.subject).toBe('acme.com')
    void part
  })

  it('cards a Canva design generation', () => {
    const part = flatPart('canvaDesign', 'generate_design', { query: 'launch poster' })
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    expect(model.appName).toBe('Canva')
    expect(model.verb.past).toBe('Generated design')
    expect(model.subject).toBe('launch poster')
  })

  it('shows the rows a sheet write actually wrote, from the request', () => {
    const part = gPart('googleSheets', 'modify_sheet_values', {
      input: { sheet_name: 'Sheet1', range: 'A1:C2', values: [['Name', 'Age'], ['Alice', 30]] },
    })
    const model = resolveToolCardModel(resolveToolIdentity(part), part.input)!
    // The response echoes nothing useful, so the card shows what was written.
    const s = model.buildSummary(normalizeToolOutput({ updatedRange: 'Sheet1!A1:C2', updatedCells: 4 }))
    expect(s.items).toEqual(['Name · Age', 'Alice · 30'])
  })

  it('returns null / false for a non-carded tool', () => {
    const part = flatPart('someUnknownTool', 'do_thing')
    expect(isVendorCard(resolveToolIdentity(part))).toBe(false)
    expect(resolveToolCardModel(resolveToolIdentity(part), part.input)).toBeNull()
  })
})

describe('terminal (bash) tool', () => {
  const bashPart = (command: string) => ({ type: 'tool-bash', input: { command } })

  it('detects a bash tool by name', () => {
    expect(isTerminalTool(resolveToolIdentity(bashPart('ls')))).toBe(true)
    expect(isTerminalTool(resolveToolIdentity(gPart('googleGmail', 'search_gmail_messages')))).toBe(false)
  })

  it('extracts the command, including a multi-line heredoc', () => {
    const cmd = "python3 << 'PYEOF'\nprint(1)\nPYEOF"
    expect(extractCommand(bashPart(cmd).input)).toBe(cmd)
  })

  it('parses a structured runCommand result with exit code', () => {
    const out = parseTerminalOutput({ exitCode: 0, stdout: 'ok\n', stderr: '' })
    expect(out.stdout).toBe('ok\n')
    expect(out.exitCode).toBe(0)
    expect(out.failed).toBe(false)
  })

  it('flags a non-zero exit as failed', () => {
    const out = parseTerminalOutput({ exitCode: 1, stderr: 'boom' })
    expect(out.failed).toBe(true)
    expect(out.stderr).toBe('boom')
  })

  it('treats a plain string result as stdout', () => {
    const out = parseTerminalOutput('hello world')
    expect(out.stdout).toBe('hello world')
    expect(out.failed).toBe(false)
  })
})
