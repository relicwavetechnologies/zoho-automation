import { Check, Clock, ShieldQuestion, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  decideDivoApproval,
  expiryLabel,
  getDivoApprovalInbox,
  isUrgent,
  type ApprovalDecision,
  type ApprovalInbox as Inbox,
  type ApprovalItem,
} from '@/lib/divo-approvals'
import { cn } from '@/lib/utils'

/**
 * Decisions waiting on you, and the ones you are waiting on.
 *
 * Approvals used to live only as a Lark DM card, so a manager who works in the
 * desktop app never saw them and a requester had no idea where their action
 * went. Both halves of that loop are here.
 */
export function ApprovalInbox({ onResolved }: { onResolved?: () => void } = {}) {
  const [inbox, setInbox] = useState<Inbox | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setInbox(await getDivoApprovalInbox())
    } catch {
      // An unreachable inbox is not worth a toast on every Tools visit; the
      // section simply does not appear.
      setInbox({ awaitingMe: [], requestedByMe: [] })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const decide = async (item: ApprovalItem, decision: ApprovalDecision) => {
    setDeciding(item.id)
    try {
      await decideDivoApproval(item.id, decision)
      // Drop it locally rather than refetching: the row is resolved, and the
      // list should not flicker back with a request that is already answered.
      setInbox(current => current ? { ...current, awaitingMe: current.awaitingMe.filter(row => row.id !== item.id) } : current)
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected', {
        description: decision === 'approved'
          ? `${item.requestedByName} can go ahead with ${item.description.title.toLowerCase()}.`
          : `${item.requestedByName} was told this was not approved.`,
      })
      onResolved?.()
    } catch (error) {
      toast.error('Could not record that decision', { description: String(error) })
      await load()
    } finally {
      setDeciding(null)
    }
  }

  if (inbox === null) return <Skeleton className="h-24 w-full rounded-lg" />
  if (!inbox.awaitingMe.length && !inbox.requestedByMe.length) return null

  return (
    <section className="flex flex-col gap-3" aria-label="Approvals">
      {inbox.awaitingMe.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div>
            <h2 className="text-base font-medium">Waiting on you</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Divo has paused these until you decide. Nothing has run yet.
            </p>
          </div>
          {inbox.awaitingMe.map(item => (
            <ApprovalRow key={item.id} item={item} busy={deciding === item.id} onDecide={decision => void decide(item, decision)} />
          ))}
        </div>
      ) : null}

      {inbox.requestedByMe.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div>
            <h2 className="text-base font-medium">Waiting on someone else</h2>
            <p className="mt-1 text-xs text-muted-foreground">Your requests, and who has to answer them.</p>
          </div>
          {inbox.requestedByMe.map(item => <ApprovalRow key={item.id} item={item} pendingOnOther />)}
        </div>
      ) : null}
    </section>
  )
}

function ApprovalRow({ item, busy = false, pendingOnOther = false, onDecide }: {
  item: ApprovalItem
  busy?: boolean
  pendingOnOther?: boolean
  onDecide?: (decision: ApprovalDecision) => void
}) {
  const expiry = expiryLabel(item.expiresAt)
  return (
    <Card data-approval-row={item.id} className="border-border/70 bg-card/40 shadow-none">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <ShieldQuestion className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {item.description.title}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{item.description.tool}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {pendingOnOther ? `Waiting on ${item.approverName}` : `Asked by ${item.requestedByName}`}
              {item.departmentName ? ` · ${item.departmentName}` : ''}
            </p>
            {item.description.details.length > 0 ? (
              <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {item.description.details.map(detail => (
                  <div key={detail.label} className="flex min-w-0 gap-1.5 text-xs">
                    <dt className="shrink-0 text-muted-foreground">{detail.label}</dt>
                    <dd className="truncate">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {expiry ? (
            <Badge variant="outline" className={cn('gap-1', isUrgent(item) && 'text-destructive')}>
              <Clock className="size-3" />{expiry}
            </Badge>
          ) : null}
          {pendingOnOther ? null : (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onDecide?.('rejected')}>
                <X data-icon="inline-start" />Reject
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onDecide?.('approved')}>
                <Check data-icon="inline-start" />Approve
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
