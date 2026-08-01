import { EmptyState } from "@/components/admin/empty-state"
import type { JsonRecord } from "@/components/admin/types"
import type { ReactNode } from "react"

/**
 * The shared table. Now rendered on the bare `.cur table` styles from
 * cursor.css rather than the shadcn Table set, so it matches every other list
 * in the app — and the loading state is shape-matched rows instead of three
 * grey slabs that reflow the moment data lands.
 */
type Column<T extends JsonRecord> = {
  key: keyof T & string
  header: string
  render?: (row: T) => ReactNode
  /** Cell + header horizontal alignment (default "left"). */
  align?: "left" | "right"
}

type DataTableProps<T extends JsonRecord> = {
  columns: Column<T>[]
  rows: T[]
  loading?: boolean
  emptyTitle: string
  emptyDescription: string
  onRowClick?: (row: T) => void
}

const renderValue = (value: unknown): ReactNode => {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return <span className="muted">{JSON.stringify(value)}</span>
}

export function DataTable<T extends JsonRecord>({ columns, rows, loading, emptyTitle, emptyDescription, onRowClick }: DataTableProps<T>) {
  if (loading) {
    return (
      <div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="ws-skel-row" key={i}>
            <div style={{ flex: 1 }}>
              <div className="ws-skel line" style={{ width: `${46 + ((i * 17) % 30)}%` }} />
            </div>
            <div className="ws-skel line" style={{ width: 64 }} />
          </div>
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={column.align === "right" ? { textAlign: "right" } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={String(row.id ?? row._id ?? index)}
              className={onRowClick ? "click" : undefined}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((column) => (
                <td key={column.key} style={column.align === "right" ? { textAlign: "right" } : undefined}>
                  {column.render ? column.render(row) : renderValue(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
