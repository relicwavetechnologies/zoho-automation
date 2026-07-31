import { ArrowRight, Settings2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import type { DivoToolInventoryItem } from '@/lib/divo-tools'
import type { ToolPresentationGroup } from '@/lib/tool-presentation'
import { cn } from '@/lib/utils'

type Props = {
  group: ToolPresentationGroup
  onManage: () => void
  onOpenDetails: () => void
}

export function ToolCatalogueCard({ group, onManage, onOpenDetails }: Props) {
  const readiness = groupReadiness(group.childTools)
  const canManage = group.childTools.some(item => item.managementScopes.length > 0)
  const approvalCount = group.childTools.filter(item => item.tool.hitlRequired).length

  return (
    <Card
      data-tool-card
      data-child-count={group.childTools.length}
      className="group flex min-h-56 flex-col overflow-hidden border-border/70 bg-card/40 shadow-none transition-colors hover:border-border hover:bg-card/70"
    >
      <CardHeader className="gap-3 p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg border bg-muted/40">
            <group.Icon className={cn('size-5', group.iconClassName)} />
          </span>
          <Badge variant={readiness.variant}>{readiness.label}</Badge>
        </div>
        <div data-card-content className="flex min-h-0 flex-col gap-1 overflow-hidden">
          <CardTitle data-card-title className="line-clamp-2 break-all text-base">{group.title}</CardTitle>
          <CardDescription data-card-purpose className="line-clamp-2 break-all text-xs">{group.description}</CardDescription>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3 p-4 pt-1">
        <p data-card-preview className="line-clamp-2 break-all text-xs font-medium text-foreground">
          {childToolPreview(group.childTools)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{actionCount(group.childTools)} action groups</Badge>
          {approvalCount > 0 ? <Badge variant="outline">{approvalCount} approval-gated</Badge> : null}
        </div>
      </CardContent>

      <CardFooter className="flex gap-2 border-t border-border/60 p-3">
        {canManage ? (
          <Button className="flex-1" variant="outline" size="sm" onClick={onManage}>
            <Settings2 data-icon="inline-start" />
            Manage access
          </Button>
        ) : null}
        <Button data-card-action className={cn(canManage ? '' : 'flex-1')} variant="ghost" size="sm" onClick={onOpenDetails}>
          Details
          <ArrowRight data-icon="inline-end" />
        </Button>
      </CardFooter>
    </Card>
  )
}

const CHILD_PREVIEW_LIMIT = 3

function childToolPreview(items: DivoToolInventoryItem[]): string {
  const names = items.slice(0, CHILD_PREVIEW_LIMIT).map(item => item.tool.name)
  const remaining = items.length - names.length
  return `${names.join(' · ')}${remaining > 0 ? ` · +${remaining} more` : ''}`
}

function actionCount(items: DivoToolInventoryItem[]): number {
  return new Set(items.flatMap(item => item.origins.flatMap(origin => 'allowedActions' in origin ? origin.allowedActions : []))).size
}

function groupReadiness(items: DivoToolInventoryItem[]): { label: string; variant: 'secondary' | 'outline' | 'destructive' } {
  if (items.some(item => item.readiness === 'connection_required')) return { label: 'Connection needed', variant: 'destructive' }
  if (items.some(item => item.readiness === 'admin_connection_required')) return { label: 'Admin connection needed', variant: 'destructive' }
  if (items.every(item => item.readiness === 'not_applicable')) return { label: 'Fixed policy', variant: 'outline' }
  return { label: 'Ready', variant: 'secondary' }
}
