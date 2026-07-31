import type { ReactNode } from 'react'

import { toolActionSummary, type DivoToolInventoryItem, type ToolManagementScope, type ToolOrigin } from '@/lib/divo-tools'
import { cn } from '@/lib/utils'

export function ToolInventoryMetadata({ item, showName = false, className }: { item: DivoToolInventoryItem; showName?: boolean; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} data-tool-id={item.tool.toolId}>
      {showName ? <p className="text-xs font-medium text-foreground">{item.tool.name}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {item.origins.map((origin, index) => <MetadataBadge key={`origin-${index}`}>{originLabel(origin)}</MetadataBadge>)}
        {item.managementScopes.map(scope => <MetadataBadge key={scopeKey(scope)}>Manage · {scopeLabel(scope)}</MetadataBadge>)}
        <MetadataBadge>Actions · {toolActionSummary(item)}</MetadataBadge>
        <MetadataBadge>{item.tool.hitlRequired ? 'Approval required' : 'No approval required'}</MetadataBadge>
        <MetadataBadge>Readiness · {readinessLabel(item.readiness)}</MetadataBadge>
      </div>
    </div>
  )
}

function MetadataBadge({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{children}</span>
}

function originLabel(origin: ToolOrigin): string {
  if (origin.kind === 'global') return `Origin · Global · ${actionList(origin.allowedActions)}`
  if (origin.kind === 'department') return `Origin · ${origin.department.name} · ${actionList(origin.allowedActions)}`
  if (origin.kind === 'local') return `Origin · Local · ${origin.reason}`
  return `Origin · System · ${actionList(origin.allowedActions)} · ${origin.reason}`
}

function actionList(actions: string[]): string {
  return actions.length ? actions.join(', ') : 'No actions'
}

function scopeKey(scope: ToolManagementScope): string {
  return scope.kind === 'global' ? 'global' : `department:${scope.department.id}`
}

function scopeLabel(scope: ToolManagementScope): string {
  return scope.kind === 'global' ? scope.label : scope.department.name
}

function readinessLabel(readiness: DivoToolInventoryItem['readiness']): string {
  switch (readiness) {
    case 'ready': return 'Ready'
    case 'connection_required': return 'Connection required'
    case 'admin_connection_required': return 'Admin connection required'
    case 'not_applicable': return 'Not applicable'
  }
}
