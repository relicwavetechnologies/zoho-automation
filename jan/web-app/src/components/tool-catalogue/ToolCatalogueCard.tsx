import { ArrowRight } from 'lucide-react'

import type { DivoToolInventoryItem } from '@/lib/divo-tools'
import type { ToolPresentationGroup } from '@/lib/tool-presentation'
import { cn } from '@/lib/utils'

export function ToolCatalogueCard({ group, onOpen }: { group: ToolPresentationGroup; onOpen: () => void }) {
  return (
    <button data-tool-card type="button" data-child-count={group.childTools.length} onClick={onOpen} className="group flex h-80 max-h-80 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/30 p-4 text-left transition-colors hover:bg-accent/50 sm:h-72 sm:max-h-72">
      <span data-card-content className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <span className="mb-4 flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/50"><group.Icon className={cn('size-5', group.iconClassName)} /></span>
        <span data-card-title className="block line-clamp-2 break-all text-base font-medium">{group.title}</span>
        <span data-card-purpose className="mt-1 block line-clamp-2 break-all text-sm text-muted-foreground">{group.description}</span>
        <span data-card-preview className="mt-4 block line-clamp-2 break-all text-xs font-medium text-foreground">{childToolPreview(group.childTools)}</span>
        <span data-card-summary className="mt-3 block space-y-1 overflow-hidden text-xs text-muted-foreground">
          <span className="block line-clamp-1 break-all">Access · {accessSummary(group.childTools)}</span>
          <span className="block line-clamp-1 break-all">Management · {managementSummary(group.childTools)}</span>
        </span>
      </span>
      <span data-card-action className="mt-3 flex shrink-0 items-center gap-1 border-t border-border/60 pt-3 text-xs font-medium text-foreground">Open details <ArrowRight aria-hidden="true" className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
    </button>
  )
}

const CHILD_PREVIEW_LIMIT = 3

function childToolPreview(items: DivoToolInventoryItem[]): string {
  const names = items.slice(0, CHILD_PREVIEW_LIMIT).map(item => item.tool.name)
  const remaining = items.length - names.length
  return `${names.join(' · ')}${remaining > 0 ? ` · +${remaining} more` : ''}`
}

function accessSummary(items: DivoToolInventoryItem[]): string {
  const originCount = items.reduce((total, item) => total + item.origins.length, 0)
  const actionCount = new Set(items.flatMap(item => item.origins.flatMap(origin => 'allowedActions' in origin ? origin.allowedActions : []))).size
  return `${originCount} ${countLabel(originCount, 'source')} · ${actionCount} ${countLabel(actionCount, 'action group')}`
}

function managementSummary(items: DivoToolInventoryItem[]): string {
  const scopeCount = items.reduce((total, item) => total + item.managementScopes.length, 0)
  const approvalCount = items.filter(item => item.tool.hitlRequired).length
  const connectionCount = items.filter(item => item.readiness === 'connection_required' || item.readiness === 'admin_connection_required').length
  return `${scopeCount} ${countLabel(scopeCount, 'scope')} · ${approvalCount} approval-gated · ${connectionCount} connection ${connectionCount === 1 ? 'issue' : 'issues'}`
}

function countLabel(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}
