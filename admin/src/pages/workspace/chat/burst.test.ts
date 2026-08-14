import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { burstMarks, summarizeBurst, type BurstStep } from './burst'

const zoho = (action: string): BurstStep => ({ tool: 'zohoBooks', action })

describe('describing a run of tool calls in one line', () => {
  /* The point of the whole file. Four reads against one system produced four
     identical "Zoho Books" rows, which buries everything else the run did under
     a repetition that carries no information. */
  it('describes a single-vendor burst instead of counting it', () => {
    const burst = [zoho('List invoices'), zoho('List contacts'), zoho('Get chart of accounts')]
    assert.equal(summarizeBurst(burst, false), 'Searched Zoho Books')
    assert.equal(summarizeBurst(burst, true), 'Searching Zoho Books')
  })

  it('takes its verb from what the calls actually did', () => {
    assert.equal(summarizeBurst([zoho('Get invoice')], false), 'Checked Zoho Books')
    assert.equal(summarizeBurst([zoho('Create invoice')], false), 'Updated Zoho Books')
    assert.equal(summarizeBurst([{ tool: 'gmail', action: 'Send message' }], false), 'Sent from Gmail')
  })

  /* A verb it cannot place must not become a wrong one. Naming the product and
     stopping is the honest floor. */
  it('names the product when the action is not a verb it knows', () => {
    assert.equal(summarizeBurst([zoho('')], false), 'Used Zoho Books')
    assert.equal(summarizeBurst([zoho('Reconcile ledger')], false), 'Used Zoho Books')
  })

  /* "Checked Files" reads as a product that does not exist. Divo's own
     capabilities are not vendors and fall through to the count. */
  it('will not turn one of Divo\'s own capabilities into a vendor sentence', () => {
    assert.equal(summarizeBurst([{ tool: 'files', action: 'Read SKILL.md' }], false), 'Explored 1 file')
    assert.equal(
      summarizeBurst([{ tool: 'terminal', action: 'ls' }, { tool: 'terminal', action: 'cat' }], false),
      'Ran 2 commands',
    )
  })

  /* A mixed burst has no one sentence — the row of marks already says who was
     involved, so the line says how much. */
  it('falls back to counts when more than one system was touched', () => {
    assert.equal(
      summarizeBurst([
        { tool: 'gmail', action: 'Search messages' },
        { tool: 'drive', action: 'List files' },
      ], false),
      'Ran 2 commands',
    )
    assert.equal(
      summarizeBurst([
        { tool: 'read', action: 'a.ts' },
        { tool: 'search', action: 'invoice' },
        { tool: 'terminal', action: 'ls' },
      ], false),
      'Explored 1 file, 1 search, ran 1 command',
    )
  })

  it('calls the plan by its name rather than counting it as a command', () => {
    assert.equal(
      summarizeBurst([{ tool: 'todo', action: 'create' }, { tool: 'read', action: 'a.ts' }], false),
      'Updated the plan, Explored 1 file',
    )
  })
})

describe('the marks a folded burst shows', () => {
  /* Presence, not volume: three Gmail calls are still one Gmail mark, because
     what the row needs to say is "this touched Gmail", not how often. */
  it('shows each system once, in the order it was first touched', () => {
    const { marks, overflow } = burstMarks([
      { tool: 'gmail', action: '' }, { tool: 'gmail', action: '' },
      { tool: 'drive', action: '' }, { tool: 'gmail', action: '' },
    ])
    assert.deepEqual(marks, ['gmail', 'drive'])
    assert.equal(overflow, 0)
  })

  it('counts the rest once there are more than the row can hold', () => {
    const { marks, overflow } = burstMarks([
      { tool: 'gmail', action: '' }, { tool: 'drive', action: '' },
      { tool: 'sheets', action: '' }, { tool: 'calendar', action: '' },
      { tool: 'lark', action: '' }, { tool: 'airtable', action: '' },
    ])
    assert.equal(marks.length, 4)
    assert.equal(overflow, 2)
  })
})
