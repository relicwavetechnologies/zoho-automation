import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTemporal, parseDrawnTable, parseFigure, plotOf, readColumns, readGrid } from './table'

describe('finding the number in a cell', () => {
  it('reads the figure through whatever symbols it is wearing', () => {
    assert.deepEqual(parseFigure('₹1,24,000'), { value: 124000, prefix: '₹', suffix: '' })
    assert.deepEqual(parseFigure('$1,234.56'), { value: 1234.56, prefix: '$', suffix: '' })
    assert.deepEqual(parseFigure('23%'), { value: 23, prefix: '', suffix: '%' })
    assert.deepEqual(parseFigure('-4.5'), { value: -4.5, prefix: '', suffix: '' })
  })

  /* A bar compares magnitudes, so `1.2k` and `1200` have to end up as the same
     height. The cell still prints what the model wrote. */
  it('scales a magnitude suffix into the value', () => {
    assert.equal(parseFigure('1.2k')?.value, 1200)
    assert.equal(parseFigure('₹9.4L')?.value, 940000)
    assert.equal(parseFigure('2Cr')?.value, 2e7)
  })

  /* The whole point of being strict. "3 weeks ago" holds a number and measures
     nothing, and a column of them right-aligned under bars would be a chart of
     the calendar. */
  it('refuses prose that happens to contain a number', () => {
    for (const cell of ['3 weeks ago', 'Q3 revenue', '12 invoices', 'v2.1 release', '']) {
      assert.equal(parseFigure(cell), null, cell)
    }
  })
})

describe('reading a column', () => {
  const rows = [['Jan', '₹1,200'], ['Feb', '₹2,400'], ['Mar', '—']]

  it('calls a column numeric on the strength of its cells', () => {
    const [label, amount] = readColumns(['Month', 'Billed'], rows)
    assert.equal(label!.numeric, false)
    assert.equal(amount!.numeric, true)
    assert.equal(amount!.prefix, '₹')
    assert.equal(amount!.max, 2400)
  })

  /* A dash is a blank, not a zero. Counted as a failed parse it would drag a
     mostly-numeric column below the threshold and lose its alignment. */
  it('ignores empty cells when deciding', () => {
    const [, amount] = readColumns(['Month', 'Billed'], rows)
    assert.deepEqual(amount!.figures.map(f => f?.value ?? null), [1200, 2400, null])
  })
})

describe('deciding whether a table is also a chart', () => {
  const months = [['Jan', '120'], ['Feb', '180'], ['Mar', '150'], ['Apr', '210']]

  it('draws a line when the labels run along a timeline', () => {
    const plot = plotOf(readColumns(['Month', 'Orders'], months), months)
    assert.equal(plot?.mark, 'line')
    assert.deepEqual(plot?.series[0]!.values, [120, 180, 150, 210])
  })

  it('draws bars when the labels are just names', () => {
    const rows = [['Pistachio', '120'], ['Vanilla', '180'], ['Mango', '150']]
    assert.equal(plotOf(readColumns(['Flavor', 'Units'], rows), rows)?.mark, 'bars')
  })

  /* The one-axis rule. A count beside a revenue figure cannot share a scale,
     and the answer is never a second axis — it is to plot the one and leave the
     other in the table, where it reads perfectly well. */
  it('drops a series that would need its own axis', () => {
    const rows = [['Jan', '1200000', '4'], ['Feb', '2400000', '7'], ['Mar', '1800000', '5']]
    const plot = plotOf(readColumns(['Month', 'Revenue', 'Deals'], rows), rows)
    assert.deepEqual(plot?.series.map(s => s.name), ['Revenue'])
  })

  it('offers nothing when there is nothing to compare', () => {
    const words = [['Name', 'Slug'], ['a', 'a'], ['b', 'b']]
    assert.equal(plotOf(readColumns(['Name', 'Slug'], words), words), null)

    const two = [['Jan', '1'], ['Feb', '2']]
    assert.equal(plotOf(readColumns(['Month', 'N'], two), two), null, 'two rows is a sentence')
  })
})

describe('recognising a timeline', () => {
  it('knows the shapes a date arrives in', () => {
    assert.equal(isTemporal(['Jan', 'Feb', 'Mar']), true)
    assert.equal(isTemporal(['2024', '2025', '2026']), true)
    assert.equal(isTemporal(['2026-07', '2026-08']), true)
    assert.equal(isTemporal(['Q1', 'Q2', 'Q3']), true)
    assert.equal(isTemporal(['Pistachio', 'Vanilla']), false)
  })
})

describe('a table the model drew by hand', () => {
  /* Exactly the shape Divo prints when asked for an inventory: a fenced block,
     pipes, and a rule under the header. */
  const drawn = [
    'Name                | Slug',
    '--------------------|------------------',
    'divo-gateway        | divo-gateway',
    'divo-chat-history   | divo-chat-history',
  ].join('\n')

  it('reads it back out as a table', () => {
    assert.deepEqual(parseDrawnTable(drawn), {
      columns: ['Name', 'Slug'],
      rows: [['divo-gateway', 'divo-gateway'], ['divo-chat-history', 'divo-chat-history']],
    })
  })

  it('leaves code alone', () => {
    for (const text of [
      'npm run build',
      'const a = b | c\nconst d = e | f',
      'Name | Slug\ndivo-gateway | divo-gateway',
    ]) {
      assert.equal(parseDrawnTable(text), null, text)
    }
  })
})

describe('reading the parsed table', () => {
  const cell = (tagName: string, text: string, href?: string) => ({
    type: 'element',
    tagName,
    children: href
      ? [{ type: 'element', tagName: 'a', properties: { href }, children: [{ type: 'text', value: text }] }]
      : [{ type: 'text', value: text }],
  })
  const row = (tagName: string, cells: [string, string?][]) => ({
    type: 'element',
    tagName: 'tr',
    children: cells.map(([text, href]) => cell(tagName, text, href)),
  })

  it('takes the grid and keeps any link a cell was carrying', () => {
    const table = {
      type: 'element',
      tagName: 'table',
      children: [
        { type: 'element', tagName: 'thead', children: [row('th', [['Invoice'], ['Amount']])] },
        {
          type: 'element',
          tagName: 'tbody',
          children: [row('td', [['INV-9', 'https://books.zoho.com/inv/9'], ['₹1,200']])],
        },
      ],
    }

    const grid = readGrid(table)
    assert.deepEqual(grid?.columns, ['Invoice', 'Amount'])
    assert.deepEqual(grid?.rows, [['INV-9', '₹1,200']])
    assert.deepEqual(grid?.hrefs, [['https://books.zoho.com/inv/9', null]])
  })
})
