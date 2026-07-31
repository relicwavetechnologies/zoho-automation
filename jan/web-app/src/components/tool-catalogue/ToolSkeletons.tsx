import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * Loading shapes for the Tools workspace.
 *
 * The section used to report loading the way it reports emptiness — a dashed
 * box holding a sentence, sometimes with a spinner. That reads as "there is
 * nothing here", tells you nothing about what is coming, and makes the page
 * jump when the real content replaces a 100px box with a 600px grid.
 *
 * These mirror the real layouts instead: the same cards, the same table, the
 * same row heights, with the *content* greyed out. The page is laid out before
 * the data lands, so arriving data fills the shape rather than replacing it.
 *
 * Every skeleton here is `aria-hidden` behind a live `role="status"` label, so
 * a screen reader hears "Loading tools" once instead of walking a fake table.
 */

function Pending({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div aria-hidden>{children}</div>
    </div>
  )
}

/**
 * The tool catalogue grid.
 *
 * Mirrors `ToolCatalogueCard` down to `min-h-56` and the footer divider, so the
 * grid does not reflow when the inventory arrives. Six is the count that fills
 * two rows at the `lg:grid-cols-3` breakpoint without inventing a scrollbar.
 */
export function ToolCardGridSkeleton({
  count = 6,
  columns = 3,
  label = 'Loading tools',
}: {
  count?: number
  columns?: 2 | 3
  label?: string
}) {
  return (
    <Pending label={label}>
      <div
        className={
          columns === 2
            ? 'grid gap-3 sm:grid-cols-2'
            : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
        }
      >
        {Array.from({ length: count }, (_, i) => (
          <Card
            key={i}
            className="flex min-h-56 flex-col overflow-hidden border-border/70 bg-card/40 shadow-none"
          >
            <CardHeader className="gap-3 p-4 pb-2">
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-full max-w-48" />
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3 p-4 pt-1">
              <Skeleton className="h-3 w-full max-w-40" />
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            </CardContent>
            <CardFooter className="gap-2 border-t border-border/60 p-3">
              <Skeleton className="h-8 flex-1 rounded-md" />
            </CardFooter>
          </Card>
        ))}
      </div>
    </Pending>
  )
}

/**
 * The department people table.
 *
 * Keeps the real header row — the columns are known before the rows are, and
 * greying out a heading you could simply render is a worse answer than showing
 * it. Only the cells are pending.
 */
export function PeopleTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Pending label="Loading department people">
      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-72" />
          </div>
        </div>
        <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Department role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-14" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: rows }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Skeleton className="size-8 rounded-full" />
                        <div className="flex flex-col gap-1.5">
                          <Skeleton className="h-3.5 w-28" />
                          <Skeleton className="h-3 w-40" />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-24 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </Pending>
  )
}

/** The department roles grid — shorter cards than the tool catalogue. */
export function RoleCardGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <Pending label="Loading department roles">
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3 w-80" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: count }, (_, i) => (
            <Card
              key={i}
              className="border-border/70 bg-card/30 shadow-none"
            >
              <CardHeader className="gap-3 p-4 pb-2">
                <div className="flex items-start justify-between">
                  <Skeleton className="size-9 rounded-lg" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-44" />
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 p-4 pt-2">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-3 w-36" />
              </CardContent>
              <CardFooter className="border-t p-3">
                <Skeleton className="h-8 w-full rounded-md" />
              </CardFooter>
            </Card>
          ))}
        </div>
      </section>
    </Pending>
  )
}

/**
 * A connection list on a tool's detail page.
 *
 * Mirrors the real row: status dot, label, two lines of meta, and the action
 * cluster on the right at `sm` and up.
 */
export function ConnectionRowsSkeleton({
  rows = 2,
  label = 'Loading connections',
}: {
  rows?: number
  label?: string
}) {
  return (
    <Pending label={label}>
      <div className="grid gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="flex flex-col gap-4 rounded-lg border border-border/70 bg-card/30 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-2 rounded-full" />
                <Skeleton className="h-4 w-40" />
              </div>
              <Skeleton className="h-3 w-56" />
              <Skeleton className="h-3 w-44" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </Pending>
  )
}

/**
 * An access scope being read — role and member rows, each with their toggles.
 * The toggle column is what the user is waiting for, so it is drawn at its real
 * size rather than implied.
 */
export function AccessScopeSkeleton({ groups = 2 }: { groups?: number }) {
  return (
    <Pending label="Loading access settings">
      <div className="space-y-5">
        {Array.from({ length: groups }, (_, g) => (
          <section key={g} className="space-y-2">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-72" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 2 }, (_, r) => (
                <div key={r} className="rounded-md border p-3">
                  <Skeleton className="h-3.5 w-28" />
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {Array.from({ length: 4 }, (_, a) => (
                      <div
                        key={a}
                        className="flex items-center justify-between gap-3"
                      >
                        <Skeleton className="h-3.5 w-32" />
                        <Skeleton className="h-5 w-9 rounded-full" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Pending>
  )
}
