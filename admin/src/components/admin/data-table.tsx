import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/admin/empty-state"
import type { JsonRecord } from "@/components/admin/types"
import type { ReactNode } from "react"

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
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">-</span>
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return <span className="text-muted-foreground">{JSON.stringify(value)}</span>
}

export function DataTable<T extends JsonRecord>({ columns, rows, loading, emptyTitle, emptyDescription, onRowClick }: DataTableProps<T>) {
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.align === "right" ? "text-right" : undefined}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={String(row.id ?? row._id ?? index)} className={onRowClick ? "cursor-pointer hover:bg-accent/5" : ""} onClick={() => onRowClick?.(row)}>
              {columns.map((column) => (
                <TableCell key={column.key} className={column.align === "right" ? "text-right" : undefined}>
                  {column.render ? column.render(row) : renderValue(row[column.key])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
