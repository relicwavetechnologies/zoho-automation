import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CHART_RUNTIME, DOCUMENT_SANDBOX, buildDocument } from './document'

/**
 * Run the chart renderer the way the frame would, and hand back what it drew.
 *
 * Enough of a document for the renderer to work against and nothing more —
 * the point is the numbers it computes, so the stub records attributes rather
 * than pretending to be a DOM.
 */
function drawChart(spec: unknown): { name: string; attrs: Record<string, string> }[] {
  const drawn: { name: string; attrs: Record<string, string> }[] = []

  const node = (name: string) => {
    const attrs: Record<string, string> = {}
    drawn.push({ name, attrs })
    return {
      setAttribute: (key: string, value: unknown) => { attrs[key] = String(value) },
      appendChild: () => {},
      set textContent(value: string) { attrs.text = value },
      style: {} as Record<string, string>,
    }
  }

  const host = {
    getAttribute: () => JSON.stringify(spec),
    textContent: '',
    appendChild: () => {},
  }

  const scope = {
    document: {
      readyState: 'complete',
      querySelectorAll: () => [host],
      createElementNS: (_ns: string, name: string) => node(name),
      createElement: (name: string) => node(name),
      createTextNode: () => ({}),
      addEventListener: () => {},
    },
  }

  new Function('window', 'document', CHART_RUNTIME)(scope, scope.document)
  return drawn
}

describe('the document wrapper', () => {
  it('never grants the frame a same origin', () => {
    /* The one assertion in this file that is load-bearing. `allow-scripts`
       together with `allow-same-origin` cancels the sandbox entirely — the
       document could then read the reader's cookies and call the app's API as
       them. Everything else here is a preference; this is the control. */
    assert.ok(DOCUMENT_SANDBOX.includes('allow-scripts'))
    assert.equal(DOCUMENT_SANDBOX.includes('allow-same-origin'), false)
  })

  it('gives the document no way to reach the network', () => {
    const page = buildDocument('<p>hi</p>')
    assert.match(page, /connect-src 'none'/)
    assert.match(page, /default-src 'none'/)
    assert.match(page, /form-action 'none'/)
    // Images are allowed only as data URIs; a remote one would be a beacon.
    assert.match(page, /img-src data:/)
  })

  it('inserts the stored body verbatim', () => {
    /* An artifact is read back byte for byte — that is the whole difference
       between a document and a chat message. Escaping or rewriting here would
       turn every stored document into markup the reader sees as text. */
    const body = `<div class="card"><span class="tag">A & B</span></div>`
    assert.ok(buildDocument(body).includes(body))
  })

  it('defines every token the design spec teaches, in both themes', () => {
    /* The seam this file exists to hold shut. `DESIGN.md` in the divo-artifact
       skill is prose read by a model; this is the code that has to make it true.
       A token documented there and missing here is a document written correctly
       against the spec that renders with a transparent background — and nothing
       else would catch it, because the model has no way to check. */
    const DOCUMENTED = [
      '--canvas', '--surface', '--inset', '--field', '--hover',
      '--ink', '--ink-2', '--ink-3',
      '--line', '--line-strong',
      '--green', '--green-tint', '--red', '--red-tint', '--orange', '--orange-tint',
      '--accent', '--accent-tint', '--accent-ink', '--link',
      '--cat-orange', '--cat-cyan', '--cat-green', '--cat-lime', '--cat-blue',
      '--cat-violet', '--cat-rose', '--cat-magenta', '--cat-grey',
    ]

    for (const theme of ['light', 'dark'] as const) {
      const page = buildDocument('', theme)
      for (const token of DOCUMENTED) {
        assert.match(page, new RegExp(`${token}:`), `${theme} is missing ${token}`)
      }
    }

    assert.match(buildDocument('', 'dark'), /data-theme="dark"/)
  })

  it('carries the same greys as the app, in both themes', () => {
    /* A document is a standalone file — it cannot read `palette.css`, so it
       carries a copy of the values. This is the thing that stops the copy
       drifting, and it is the only reason the copy is allowed to exist.

       Read from the stylesheet rather than restated here: an expectation
       written out in this file would be a *third* copy, and a third copy drifts
       from the first two while the test goes on passing. */
    const palette = readFileSync(
      new URL('../../../styles/palette.css', import.meta.url), 'utf8',
    )
    const block = (selector: string): Record<string, string> => {
      const body = palette.slice(palette.indexOf(`${selector} {`))
      const out: Record<string, string> = {}
      for (const [, name, value] of body.slice(0, body.indexOf('}')).matchAll(/(--bui-[a-z0-9-]+):\s*([^;]+);/g)) {
        out[name!] = value!.trim()
      }
      return out
    }
    /* `.dark` restates only what changes, so light is the base and dark is laid
       over it — exactly how the browser resolves them. */
    const light = block(':root')
    const dark = { ...light, ...block('.dark') }

    /* `--accent*` is deliberately absent: it is ink in a document, not the app's
       blue. See the note above LIGHT. Every other token must match. */
    const MIRRORS: Record<string, string> = {
      '--canvas': '--bui-canvas', '--surface': '--bui-surface', '--inset': '--bui-inset',
      '--field': '--bui-field', '--hover': '--bui-hover',
      '--ink': '--bui-ink', '--ink-2': '--bui-ink-2', '--ink-3': '--bui-ink-3',
      '--line': '--bui-line', '--line-strong': '--bui-line-strong',
      '--green': '--bui-green', '--green-tint': '--bui-green-tint',
      '--red': '--bui-red', '--red-tint': '--bui-red-tint',
      '--orange': '--bui-orange', '--orange-tint': '--bui-orange-tint',
      '--link': '--bui-accent-ink',
    }

    for (const [theme, values] of [['light', light], ['dark', dark]] as const) {
      const page = buildDocument('', theme)
      for (const [own, mirrored] of Object.entries(MIRRORS)) {
        assert.match(
          page, new RegExp(`\\${own}: ${values[mirrored]!};`),
          `${theme} ${own} has drifted from ${mirrored} (${values[mirrored]})`,
        )
      }
    }
  })

  it('keeps the categorical hues identical across themes', () => {
    /* These classify rather than mean, so they must not drift: a series that is
       violet in light and lavender in dark is two different series to anyone
       comparing two screenshots. */
    for (const hue of ['--cat-violet: #9a5cff', '--cat-cyan: #16a6c7', '--cat-grey: #7f858d']) {
      assert.ok(buildDocument('', 'light').includes(hue))
      assert.ok(buildDocument('', 'dark').includes(hue))
    }
  })

  it('plots a series against a scale that includes zero', () => {
    /* The whole reason charts are not left to the model. A 0–100 series over
       three points, in a 600x240 box with 48/12/12/26 padding, lands on exactly
       these coordinates — bottom, middle, top — and the middle one is only at
       the middle because the domain starts at zero rather than at the series
       minimum. A chart cropped to its own range would put it elsewhere and
       still look plausible. */
    const line = drawChart({
      type: 'line',
      labels: ['a', 'b', 'c'],
      series: [{ label: 'S', color: 'var(--cat-cyan)', points: [0, 50, 100] }],
    }).find(node => node.name === 'polyline')

    assert.equal(line?.attrs.points, '48,214 318,113 588,12')
  })

  it('rounds the axis outward so gridlines carry round numbers', () => {
    /* 0..47 is not a scale a person would draw. The renderer widens it to 0..50
       in steps of 10, which is what someone would have written by hand. */
    const ticks = drawChart({
      type: 'line',
      series: [{ label: 'S', points: [3, 47] }],
    }).filter(node => node.name === 'text').map(node => node.attrs.text)

    assert.deepEqual(ticks, ['0', '10', '20', '30', '40', '50'])
  })

  it('keeps a negative series anchored to its own zero line', () => {
    /* Bars for a series that crosses zero must grow from the zero line in both
       directions. Getting this wrong draws a decline as a shorter increase. */
    const bars = drawChart({
      type: 'bar',
      series: [{ label: 'S', points: [10, -10] }],
    }).filter(node => node.name === 'rect')

    assert.equal(bars.length, 2)
    // Same height either side of zero, and the falling bar starts where the
    // rising one ends.
    assert.equal(bars[0]?.attrs.height, bars[1]?.attrs.height)
    assert.equal(bars[0]?.attrs.y !== bars[1]?.attrs.y, true)
  })

  it('tiles a hex cluster in proportion, smallest share at the core', () => {
    /* Two claims at once. The counts are proportional — 9 of 60 is 15% of the
       filled tiles — and the ordering is centre-out ascending, which is what
       makes the shape readable. Filled in declaration order the regions
       interleave and the cluster stops meaning anything. */
    const cells = drawChart({
      type: 'hex',
      series: [
        { label: 'Big', color: 'BLUE', value: 51 },
        { label: 'Small', color: 'VIOLET', value: 9 },
      ],
    }).filter(node => node.name === 'polygon')

    assert.equal(cells.length, 26 * 17)
    assert.equal(cells[0]?.attrs.fill, 'VIOLET', 'the core cell is the smallest share')
    assert.equal(
      cells[cells.length - 1]?.attrs.fill, 'var(--field)', 'the outermost cell is unfilled',
    )

    const violet = cells.filter(c => c.attrs.fill === 'VIOLET').length
    const blue = cells.filter(c => c.attrs.fill === 'BLUE').length
    assert.equal(violet, 38)
    assert.equal(blue, 218)
    // The larger share takes the remainder, so the tiles always sum exactly
    // rather than leaving a stray pale gap from rounding.
    assert.equal(violet + blue, 256)
  })

  it('fills a dot field from the baseline up to the value', () => {
    const dots = drawChart({
      type: 'dot',
      series: [{ label: 'Revenue', color: 'ORANGE', points: [0, 100] }],
    }).filter(node => node.name === 'circle')

    assert.equal(dots.length, 56 * 22)
    // Leftmost column sits at the domain floor, rightmost at the ceiling.
    assert.ok(dots.slice(0, 22).every(d => d.attrs.fill === 'var(--line)'))
    assert.ok(dots.slice(-22).every(d => d.attrs.fill === 'ORANGE'))
  })

  it('says so rather than drawing nothing when the data is unusable', () => {
    const empty = drawChart({ type: 'line', series: [] })
    assert.equal(empty.length, 0)
  })

  it('ships the chart renderer the design spec promises', () => {
    /* The spec forbids hand-written chart SVG and tells the model to emit
       `.chart[data-chart]` instead. That instruction is only true if the thing
       reading the attribute actually travels with the document. */
    const page = buildDocument('')
    assert.match(page, /\.chart\[data-chart\]/)
    assert.match(page, /createElementNS/)
  })
})
