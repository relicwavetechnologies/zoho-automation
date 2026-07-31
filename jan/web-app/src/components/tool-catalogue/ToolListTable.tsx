import { ChevronRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { DepartmentToolCoverage } from '@/lib/divo-tools'
import { ceilingState, coverageLabel, toolStatus } from '@/lib/tool-access-model'
import type { ToolPresentationGroup } from '@/lib/tool-presentation'
import { cn } from '@/lib/utils'

export type ToolRow = {
  group: ToolPresentationGroup
  coverage: DepartmentToolCoverage[]
}

/**
 * The tools list.
 *
 * There used to be two buttons on every card — "Manage access" and "Details" —
 * where one was a strict subset of the other: the detail page already rendered
 * the same access section the sheet did. The row is the only target now, and
 * everything about a tool lives on its own page.
 */
export function ToolListTable({ rows, totalPeople, showCoverage, onOpen }: {
  rows: ToolRow[]
  totalPeople: number
  showCoverage: boolean
  onOpen: (group: ToolPresentationGroup) => void
}) {
  return (
    <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            {showCoverage ? <TableHead className="min-w-32">Who can use it</TableHead> : null}
            {showCoverage ? <TableHead className="min-w-28">Approval</TableHead> : null}
            <TableHead className="min-w-28">Status</TableHead>
            <TableHead className="w-10"><span className="sr-only">Open</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? rows.map(({ group, coverage }) => {
            const status = toolStatus(group.childTools)
            const people = coverage.reduce((most, entry) => Math.max(most, entry.peopleWithAccess), 0)
            const approvals = coverage.reduce((count, entry) => count + entry.approvalActions.length, 0)
            const ceiling = coverage.find(entry => ceilingState(entry).kind !== 'clear')
            return (
              <TableRow key={group.id} className="cursor-pointer" onClick={() => onOpen(group)}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                      <group.Icon className={cn('size-4.5', group.iconClassName)} />
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium">{group.title}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{capabilitySummary(group)}</div>
                    </div>
                  </div>
                </TableCell>
                {showCoverage ? (
                  <TableCell className={people === 0 ? 'text-muted-foreground' : undefined}>
                    {coverage.length ? coverageLabel(people, totalPeople) : <span className="text-muted-foreground">—</span>}
                    {ceiling ? <div className="mt-0.5 text-xs text-amber-400">Limited by company policy</div> : null}
                  </TableCell>
                ) : null}
                {showCoverage ? (
                  <TableCell>
                    {approvals ? <Badge variant="outline">{approvals} needs approval</Badge> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                ) : null}
                <TableCell>
                  <Badge variant={status.kind === 'attention' ? 'destructive' : status.kind === 'ready' ? 'secondary' : 'outline'}>
                    {status.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground"><ChevronRight className="size-4" /></TableCell>
              </TableRow>
            )
          }) : (
            <TableRow>
              <TableCell colSpan={showCoverage ? 5 : 3} className="h-24 text-center text-muted-foreground">
                Nothing matches that search.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  )
}

function capabilitySummary(group: ToolPresentationGroup): string {
  const names = group.childTools.map(item => item.tool.name)
  if (names.length <= 3) return names.join(' · ')
  return `${names.slice(0, 3).join(' · ')} +${names.length - 3}`
}
