/**
 * Reading a table the model wrote.
 *
 * The model writes markdown, and a markdown table is a grid of strings. What
 * makes it *look* like data — figures that line up, a bar behind a magnitude, a
 * chart offered beside it — needs to know which columns are numbers, and that
 * is not written down anywhere. It is inferred here, mechanically, and only
 * ever used for alignment and geometry: **every cell still renders the exact
 * text the model wrote.** Reformatting a number means deciding it was rupees
 * rather than dollars, and being quietly wrong about someone's money is worse
 * than leaving their own formatting alone.
 */

/** A number found inside a cell, and the symbols it was wearing. */
export type Figure = {
  /** Scaled: `1.2k` is 1200, because a bar has to be able to compare them. */
  value: number
  /** `₹`, `$`, … — what came before the digits. */
  prefix: string
  /** `%`, ` kg`, … — what came after, minus any magnitude suffix. */
  suffix: string
}

const MULTIPLIER: Record<string, number> = {
  k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9,
  /* Indian magnitudes, which Divo's own figures are usually written in. */
  L: 1e5, lakh: 1e5, Cr: 1e7, cr: 1e7, crore: 1e7,
}

const CURRENCY = '₹$€£¥'

/**
 * The number in a cell, or null if the cell is prose.
 *
 * Deliberately strict about what may sit around the digits: a currency symbol
 * in front, a percent or a magnitude behind. "3 weeks ago" holds a number and
 * is not a measurement, and a column of them right-aligned under a bar would be
 * a chart of nothing.
 */
export function parseFigure(text: string): Figure | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const match = /^([^\d+-]*)([+-]?)([\d,\s]*\d(?:\.\d+)?)(.*)$/.exec(trimmed)
  if (!match) return null

  const [, rawPrefix, sign, digits, rawSuffix] = match
  const prefix = rawPrefix!.trim()
  if (prefix && ![...prefix].every(char => CURRENCY.includes(char))) return null

  const bare = digits!.replace(/[,\s]/g, '')
  if (!bare) return null
  const magnitude = Object.keys(MULTIPLIER)
    .sort((a, b) => b.length - a.length)
    .find(key => rawSuffix!.trim().startsWith(key))
  const suffix = magnitude ? rawSuffix!.trim().slice(magnitude.length).trim() : rawSuffix!.trim()

  // Anything left over is a word, and a word means this was never a figure.
  if (suffix && suffix !== '%') return null

  const value = Number(bare) * (magnitude ? MULTIPLIER[magnitude]! : 1)
  if (!Number.isFinite(value)) return null
  return { value: sign === '-' ? -value : value, prefix, suffix }
}

export type Column = {
  name: string
  numeric: boolean
  prefix: string
  suffix: string
  /** Largest absolute value in the column — the scale a magnitude bar uses. */
  max: number
  /** Every row's figure, in row order, with nulls where the cell was prose. */
  figures: (Figure | null)[]
}

/** How much of a column has to parse before the column counts as numeric. */
const NUMERIC_SHARE = 0.6

export function readColumns(columns: readonly string[], rows: readonly string[][]): Column[] {
  return columns.map((name, index) => {
    const cells = rows.map(row => row[index] ?? '')
    const figures = cells.map(parseFigure)
    const filled = cells.filter(cell => cell.trim()).length
    const found = figures.filter(Boolean).length
    const numeric = filled > 0 && found / filled >= NUMERIC_SHARE

    const present = figures.filter((f): f is Figure => f !== null)
    return {
      name,
      numeric,
      prefix: present.find(f => f.prefix)?.prefix ?? '',
      suffix: present.find(f => f.suffix)?.suffix ?? '',
      max: present.reduce((n, f) => Math.max(n, Math.abs(f.value)), 0),
      figures,
    }
  })
}

/* ── Is there a chart in here? ────────────────────────────
   The table is always the answer; a chart is only ever offered beside it. So
   the bar for offering one is high, and the shape has to be unambiguous. */

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i
const DAYS = /^(mon|tue|wed|thu|fri|sat|sun)/i

/** Labels that run along a timeline, which is the only reason to draw a line. */
export function isTemporal(labels: readonly string[]): boolean {
  const dated = labels.filter(label => {
    const value = label.trim()
    return MONTHS.test(value)
      || DAYS.test(value)
      || /^(19|20)\d{2}$/.test(value)
      || /^(19|20)\d{2}[-/]\d{1,2}/.test(value)
      || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(value)
      || /^q[1-4]\b/i.test(value)
      || /^(week|wk)\s*\d+/i.test(value)
  })
  return labels.length > 0 && dated.length / labels.length >= 0.8
}

export type Series = { name: string; values: (number | null)[] }

export type Plot = {
  mark: 'line' | 'bars'
  labels: string[]
  series: Series[]
  prefix: string
  suffix: string
}

/** Too few rows and the table already said it; too many and a chart is a smear. */
const MIN_ROWS = 3
const MAX_ROWS = 24
/** Series more than this far apart in scale would need a second axis. Never. */
const SCALE_LIMIT = 25
const MAX_SERIES = 4

/**
 * The chart this table could become, or null.
 *
 * The one-axis rule does the interesting work here. Two columns whose
 * magnitudes are wildly apart — a count beside a revenue figure — cannot share
 * a scale, and the fix is never a second axis; it is to plot the first and
 * leave the other in the table where it is perfectly readable.
 */
export function plotOf(columns: readonly Column[], rows: readonly string[][]): Plot | null {
  const [first, ...rest] = columns
  if (!first || first.numeric) return null
  if (rows.length < MIN_ROWS || rows.length > MAX_ROWS) return null

  const numeric = rest.filter(column => column.numeric && column.max > 0)
  if (numeric.length === 0) return null

  const leader = numeric[0]!
  const sharing = numeric
    .filter(column => column.max / leader.max <= SCALE_LIMIT && leader.max / column.max <= SCALE_LIMIT)
    .slice(0, MAX_SERIES)

  const labels = rows.map(row => (row[0] ?? '').trim())
  if (labels.some(label => !label)) return null

  return {
    mark: isTemporal(labels) ? 'line' : 'bars',
    labels,
    series: sharing.map(column => ({
      name: column.name,
      values: column.figures.map(figure => figure?.value ?? null),
    })),
    prefix: leader.prefix,
    suffix: leader.suffix,
  }
}

/* ── Tables the model drew by hand ────────────────────────
   Divo does not always write GFM. Asked for an inventory it will happily print
   a fenced block with pipes and a row of dashes under the header, which is a
   table by every measure except the one the parser uses — and it arrives as a
   wall of monospace. This reads that shape back out. It is a mechanical
   recognition, not a guess: pipes on every line and a separator under the
   header, or it is left alone as the code block it claims to be. */

export type Grid = { columns: string[]; rows: string[][] }

/* ── Reading the parsed table ─────────────────────────────
   The table is drawn from its own data rather than by decorating what
   react-markdown produced, because alignment, folding and the chart all need to
   know about the column as a whole and a `<td>` renderer only ever sees a cell.
   The cost is that emphasis inside a cell is flattened to its text — a link is
   kept, because a link is the one thing in a cell that does something. */

type HastNode = {
  type?: string
  tagName?: string
  value?: string
  children?: HastNode[]
  properties?: Record<string, unknown>
}

export function textOf(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function firstHref(node: HastNode | undefined): string | null {
  if (!node) return null
  if (node.tagName === 'a') {
    const href = node.properties?.['href']
    return typeof href === 'string' ? href : null
  }
  for (const child of node.children ?? []) {
    const found = firstHref(child)
    if (found) return found
  }
  return null
}

function rowsUnder(node: HastNode, tag: string): HastNode[] {
  const found: HastNode[] = []
  const walk = (current: HastNode) => {
    for (const child of current.children ?? []) {
      if (child.tagName === tag) found.push(child)
      else walk(child)
    }
  }
  walk(node)
  return found
}

export type ParsedTable = Grid & { hrefs: (string | null)[][] }

export function readGrid(node: HastNode | undefined): ParsedTable | null {
  if (!node) return null
  const rows = rowsUnder(node, 'tr')
  if (rows.length < 2) return null

  const cellsOf = (row: HastNode) =>
    (row.children ?? []).filter(child => child.tagName === 'th' || child.tagName === 'td')

  const header = cellsOf(rows[0]!)
  if (header.length < 2) return null
  const columns = header.map(cell => textOf(cell).trim())

  const body = rows.slice(1).map(cellsOf).filter(cells => cells.length === columns.length)
  if (body.length === 0) return null

  return {
    columns,
    rows: body.map(cells => cells.map(cell => textOf(cell).trim())),
    hrefs: body.map(cells => cells.map(firstHref)),
  }
}

const SEPARATOR = /^[\s|:+-]*-[\s|:+-]*$/

export function parseDrawnTable(text: string): Grid | null {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length < 3) return null
  if (!lines.every(line => line.includes('|'))) return null
  if (!SEPARATOR.test(lines[1]!)) return null
  // A separator anywhere else means this is a drawing, not a table.
  if (lines.slice(2).some(line => SEPARATOR.test(line))) return null

  const cells = (line: string) => {
    const parts = line.split('|').map(part => part.trim())
    if (parts[0] === '') parts.shift()
    if (parts[parts.length - 1] === '') parts.pop()
    return parts
  }

  const columns = cells(lines[0]!)
  if (columns.length < 2 || columns.some(name => !name)) return null

  const rows = lines.slice(2).map(cells).filter(row => row.length === columns.length)
  if (rows.length === 0) return null

  return { columns, rows }
}
