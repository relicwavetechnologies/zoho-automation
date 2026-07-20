import { memo, useMemo } from 'react'
import { CircleXIcon, Clock3Icon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  readDivoGatewayApproval,
  type DivoGatewayApproval,
} from '@/lib/pi/gateway-approval'
import { resolveToolLabel } from '@/lib/pi/tool-label'

type DivoApprovalStatusCardProps = {
  part: {
    type?: string
    toolName?: string
    input?: unknown
    output?: unknown
    error?: unknown
    errorText?: unknown
  }
}

function statusLabel(approval: DivoGatewayApproval): string {
  return approval.state === 'pending' ? 'Approval pending' : 'Not approved'
}

/**
 * A backend-HITL result in its owning gateway trace row.
 *
 * This is intentionally a status display only. Approval remains in the
 * backend/Lark, and a later gateway call remains responsible for any action.
 */
export const DivoApprovalStatusCard = memo(({ part }: DivoApprovalStatusCardProps) => {
  const approval = useMemo(
    () => readDivoGatewayApproval(part),
    [part.error, part.errorText, part.output, part.toolName, part.type]
  )
  if (!approval) return null

  const pending = approval.state === 'pending'
  const toolLabel = resolveToolLabel(part) || 'tool call'

  return (
    <section
      className="my-1 flex max-w-[70ch] gap-2.5 py-1 text-sm"
      data-testid="divo-approval-status"
      data-status={approval.state}
    >
      <span className="flex h-5 shrink-0 items-center">
        {pending ? (
          <Clock3Icon className="size-4 text-amber-600 dark:text-amber-400" />
        ) : (
          <CircleXIcon className="size-4 text-destructive" />
        )}
      </span>
      <div className="min-w-0 border-l border-border pl-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] text-foreground">{statusLabel(approval)}</span>
          <span
            className={cn(
              'text-[11px] font-medium uppercase tracking-wide',
              pending
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-destructive'
            )}
          >
            {pending ? 'Waiting' : 'Rejected'}
          </span>
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          {pending
            ? `Divo is waiting for the approval decision before it runs this ${toolLabel}.`
            : `Divo did not run this ${toolLabel}.`}
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground/80">
          {approval.message}
        </p>
        {approval.approvalId && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground/60">
            Approval {approval.approvalId}
          </p>
        )}
      </div>
    </section>
  )
})

DivoApprovalStatusCard.displayName = 'DivoApprovalStatusCard'
