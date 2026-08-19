/**
 * A table the model wrote, drawn as data.
 *
 * **The chart leads when there is one.** `plotOf` only returns a plot for a
 * shape that is unambiguous — a labelled first column, a bounded row count,
 * positive numerics on comparable scales — so wherever a chart exists at all it
 * is the faster read, and the table is one press away underneath it.
 *
 * The rest of what makes this readable has nothing to do with the chart: that
 * figures sit under each other in tabular figures instead of ragging, that a
 * long result folds instead of becoming a wall, and that a magnitude carries a
 * hairline you can compare down the column without reading a single number.
 * That still matters, because most results never qualify for a plot and land on
 * the table regardless of this default.
 */
import { useMemo, useState } from 'react'
import { PlotView } from './chart'
import { plotOf, readColumns, type Column, type ParsedTable } from './table'
import { SourceLink } from './links.view'

/** Rows shown before the table folds, and how many survive the fold. */
const FOLD_AT = 14
const FOLDED = 10

export function DataTable({ table }: { table: ParsedTable }) {
  const [open, setOpen] = useState(false)
  /* Safe as a default because the render falls back on its own: with no plot to
     draw, `charted` is true and the table renders anyway, and the toggle that
     would contradict it is not shown. So this is "chart when there is one",
     not "chart even when there isn't". */
  const [charted, setCharted] = useState(true)

  const columns = useMemo(() => readColumns(table.columns, table.rows), [table])
  const plot = useMemo(() => plotOf(columns, table.rows), [columns, table.rows])

  const folded = table.rows.length > FOLD_AT && !open
  const rows = folded ? table.rows.slice(0, FOLDED) : table.rows
  const hidden = table.rows.length - rows.length

  return (
    <figure
      className="my-3 overflow-hidden rounded-control bg-surface shadow-hairline"
      style={{ animation: 'bui-fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      {charted && plot ? <PlotView plot={plot} /> : (
        <div className="overflow-x-auto">
          <table className="bui-data">
            <thead>
              <tr>
                {columns.map(column => (
                  <th key={column.name} data-numeric={column.numeric} className="border-b border-line">
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="transition-colors duration-100 hover:bg-fill">
                  {row.map((cell, ci) => (
                    <Cell
                      key={ci}
                      text={cell}
                      href={table.hrefs[ri]?.[ci] ?? null}
                      column={columns[ci]}
                      row={ri}
                      first={ci === 0}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <figcaption className="flex items-center justify-between gap-3 border-t border-line px-2.5 py-1.5">
        <span className="flex items-center gap-2 text-[11px] text-ink-3">
          <span className="tabular-nums">{table.rows.length}</span>
          {table.rows.length === 1 ? 'row' : 'rows'}
          {folded && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-ink-2 underline decoration-line underline-offset-2 transition-colors hover:text-ink"
            >
              Show all
            </button>
          )}
          {!folded && hidden === 0 && table.rows.length > FOLD_AT && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-ink-2 underline decoration-line underline-offset-2 transition-colors hover:text-ink"
            >
              Show less
            </button>
          )}
        </span>

        {plot && (
          <span className="flex items-center gap-0.5 rounded-full bg-inset p-0.5">
            <Toggle on={!charted} onClick={() => setCharted(false)}>Table</Toggle>
            <Toggle on={charted} onClick={() => setCharted(true)}>Chart</Toggle>
          </span>
        )}
      </figcaption>
    </figure>
  )
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full px-2 py-[3px] text-[11px] transition-colors duration-100 ${
        on ? 'bg-surface text-ink shadow-hairline' : 'text-ink-3 hover:text-ink-2'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * One cell.
 *
 * The bar behind a figure is drawn only where it can be compared: a column of
 * positive numbers with a real maximum. Negative values, or a column of two,
 * get the number alone — a bar chart of one row is a rectangle.
 */
function Cell({
  text, href, column, row, first,
}: {
  text: string
  href: string | null
  column: Column | undefined
  row: number
  first: boolean
}) {
  const figure = column?.figures[row] ?? null
  const bar =
    column?.numeric
    && column.max > 0
    && column.figures.every(f => (f?.value ?? 0) >= 0)
    && figure !== null

  return (
    <td
      data-numeric={column?.numeric}
      className={`relative ${
        column?.numeric ? 'text-ink' : first ? 'font-medium text-ink' : 'text-ink-2'
      }`}
    >
      {href ? <SourceLink href={href} text={text} /> : text || <span className="text-ink-3">—</span>}
      {bar && (
        <span
          aria-hidden
          className="absolute bottom-[3px] right-3 h-[2px] rounded-full bg-[var(--bui-line-strong)]"
          style={{ width: `${Math.max(2, (Math.abs(figure.value) / column!.max) * 42)}px` }}
        />
      )}
    </td>
  )
}
