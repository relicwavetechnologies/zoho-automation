import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Paperclip,
  ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'

import { GmailIcon, ZohoIcon } from '@/components/brand-icons'
import { MemoryReviewCard } from '@/components/memory-review/MemoryReviewCard'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { usePiApproval, type PiPendingUiRequest } from '@/hooks/usePiApproval'
import { isPiMemoryReviewRequest } from '@/lib/pi/memory-review'
import { cn } from '@/lib/utils'

type ApprovalAppKind = 'gmail' | 'zoho' | 'generic'

type LiveApprovalComposerProps = {
  request: PiPendingUiRequest
  position: number
  total: number
  onMove: (direction: -1 | 1) => void
  onDecision: (confirmed: boolean) => void
  onAlwaysAllowBash?: () => void
  onStop: () => void
  now: number
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return fallback
}

function displayPerson(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  const name = stringValue(record.name)
  const email = stringValue(record.email ?? record.address)
  return name && email ? `${name} · ${email}` : name || email
}

function displayPeople(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(displayPerson).filter(Boolean).join(', ')
  }
  return displayPerson(value)
}

function presentationDetails(
  presentation: Record<string, unknown>
): Record<string, unknown> {
  const details = presentation.details
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return details as Record<string, unknown>
  }
  return presentation
}

function appKind(request: Exclude<PiPendingUiRequest, { protocol: 'memory-review' }>): ApprovalAppKind {
  const identity = `${request.descriptor.source} ${request.descriptor.kind}`.toLowerCase()
  if (identity.includes('gmail')) return 'gmail'
  if (identity.includes('zoho')) return 'zoho'
  return 'generic'
}

function appName(kind: ApprovalAppKind, source: string) {
  if (kind === 'gmail') return 'Gmail'
  if (kind === 'zoho') return 'Zoho'
  return source
}

function approveLabel(action: string) {
  switch (action.toLowerCase()) {
    case 'send':
      return 'Approve & send'
    case 'create':
      return 'Approve creation'
    case 'update':
      return 'Approve update'
    case 'delete':
      return 'Approve deletion'
    case 'execute':
    case 'run':
      return 'Approve & run'
    default:
      return 'Approve action'
  }
}

export function LiveApprovalComposer({
  request,
  position,
  total,
  onMove,
  onDecision,
  onAlwaysAllowBash,
  onStop,
  now,
}: LiveApprovalComposerProps) {
  if (isPiMemoryReviewRequest(request)) {
    return (
      <MemoryReviewCard
        key={request.requestId}
        request={request}
        position={position}
        total={total}
        onMove={onMove}
        onSubmit={(response) =>
          void usePiApproval
            .getState()
            .resolveMemory(request.threadId, request.requestId, response)
        }
      />
    )
  }
  const kind = appKind(request)
  const { descriptor } = request
  const details = presentationDetails(descriptor.presentation)
  const submitting = request.status === 'submitting'
  const expired = request.expiresAt <= now
  const canAlwaysAllowBash = descriptor.source === 'bash'
  const description =
    stringValue(descriptor.presentation.description ?? details.description) ||
    `${appName(kind, descriptor.source)} is waiting to perform this action.`

  return (
    <Card
      className="overflow-hidden rounded-3xl border-input bg-card shadow-none"
      data-testid="live-approval-composer"
    >
      <CardHeader className="flex-row items-start justify-between gap-4 p-4 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <BrandTile kind={kind} />
          <div className="min-w-0">
            <CardDescription className="mb-1 flex items-center gap-1.5 text-xs">
              <ShieldCheck />
              {appName(kind, descriptor.source)} · {descriptor.action}
            </CardDescription>
            <CardTitle className="text-base font-medium leading-6 tracking-normal">
              {descriptor.title}
            </CardTitle>
            <CardDescription className="mt-1 leading-5">
              {description}
            </CardDescription>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {position + 1} / {total}
          </span>
          <ButtonGroup>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={total < 2 || submitting}
              aria-label="Previous pending approval"
              onClick={() => onMove(-1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={total < 2 || submitting}
              aria-label="Next pending approval"
              onClick={() => onMove(1)}
            >
              <ChevronRight />
            </Button>
          </ButtonGroup>
        </div>
      </CardHeader>

      <Separator />

      <CardContent className="flex flex-col gap-3 p-4">
        {kind === 'gmail' ? (
          <GmailRequest presentation={descriptor.presentation} />
        ) : kind === 'zoho' ? (
          <ZohoRequest presentation={descriptor.presentation} />
        ) : (
          <GenericRequest presentation={descriptor.presentation} />
        )}
        <ExactRequestDetails request={request} />
        {request.status === 'error' ? (
          <p className="text-sm text-destructive" role="alert">
            Decision was not delivered. Divo remains paused. {request.error}
          </p>
        ) : null}
        {expired ? (
          <p className="text-sm text-destructive" role="status">
            This request expired and can only be safely denied.
          </p>
        ) : null}
        {canAlwaysAllowBash ? (
          <div className="flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>
              Always allowing Bash lets future terminal commands in this task
              modify or delete files, access local data, and use the network
              without another review. Stop the run to revoke it.
            </span>
          </div>
        ) : null}
      </CardContent>

      <Separator />

      <CardFooter className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LockKeyhole />
          <span>Approval applies only to this exact action.</span>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Button variant="ghost" onClick={onStop}>
            Stop run
          </Button>
          <Button
            variant="outline"
            className="flex-1 sm:flex-none"
            disabled={submitting}
            onClick={() => onDecision(false)}
          >
            {submitting ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {expired ? 'Deny expired request' : 'Deny'}
          </Button>
          {canAlwaysAllowBash && onAlwaysAllowBash ? (
            <Button
              variant="secondary"
              disabled={submitting || expired}
              onClick={onAlwaysAllowBash}
            >
              Always allow Bash for this task
            </Button>
          ) : null}
          <Button
            className="flex-1 sm:flex-none"
            disabled={submitting || expired}
            onClick={() => onDecision(true)}
          >
            {submitting ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <ShieldCheck data-icon="inline-start" />
            )}
            {approveLabel(descriptor.action)}
          </Button>
        </div>
      </CardFooter>

      <div className="bg-muted/35 px-4 py-2 text-center text-[11px] text-muted-foreground">
        Divo is paused until you approve or deny this request
      </div>
    </Card>
  )
}

function BrandTile({ kind }: { kind: ApprovalAppKind }) {
  return (
    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background">
      {kind === 'gmail' ? (
        <GmailIcon className="size-6" />
      ) : kind === 'zoho' ? (
        <ZohoIcon className="h-6 w-8" />
      ) : (
        <ShieldCheck className="size-6" />
      )}
    </div>
  )
}

function GmailRequest({
  presentation,
}: {
  presentation: Record<string, unknown>
}) {
  const details = presentationDetails(presentation)
  const from =
    displayPerson(details.from) ||
    stringValue(details.account ?? details.connectionId, 'Selected Gmail account')
  const to = displayPeople(details.to) || 'Not specified'
  const cc = displayPeople(details.cc)
  const subject = stringValue(details.subject, '(No subject)')
  const body = stringValue(
    details.bodyText ?? details.body ?? details.content ?? details.bodyHtml
  )
  const attachments = Array.isArray(details.attachments)
    ? details.attachments
    : []

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
      <div className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[72px_minmax(0,1fr)]">
        <span className="text-muted-foreground">From</span>
        <span className="truncate">{from}</span>
        <span className="text-muted-foreground">To</span>
        <span className="truncate">{to}</span>
        {cc ? (
          <>
            <span className="text-muted-foreground">Cc</span>
            <span className="truncate">{cc}</span>
          </>
        ) : null}
        <span className="text-muted-foreground">Subject</span>
        <span className="font-medium">{subject}</span>
      </div>
      {body ? (
        <>
          <Separator />
          <div className="whitespace-pre-wrap px-4 py-3 text-sm leading-6">
            {body}
          </div>
        </>
      ) : null}
      {attachments.length > 0 ? (
        <>
          <Separator />
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground">
            <Paperclip />
            {attachments.map((attachment, index) => (
              <span key={`${displayPerson(attachment)}-${index}`}>
                {displayPerson(attachment) ||
                  stringValue(
                    (attachment as Record<string, unknown>)?.name,
                    `Attachment ${index + 1}`
                  )}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

function ZohoRequest({
  presentation,
}: {
  presentation: Record<string, unknown>
}) {
  const details = presentationDetails(presentation)
  const explicitChanges = Array.isArray(details.changes)
    ? details.changes.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const record = value as Record<string, unknown>
        return [
          {
            field: stringValue(record.field ?? record.label, 'Field'),
            before: stringValue(record.before ?? record.from, '—'),
            after: stringValue(record.after ?? record.to, '—'),
          },
        ]
      })
    : []
  const fields =
    details.fields &&
    typeof details.fields === 'object' &&
    !Array.isArray(details.fields)
      ? (details.fields as Record<string, unknown>)
      : undefined
  const changes =
    explicitChanges.length > 0
      ? explicitChanges
      : Object.entries(fields ?? {}).map(([field, after]) => ({
          field,
          before: '',
          after: stringValue(after, JSON.stringify(after)),
        }))
  const recordType = stringValue(
    details.recordType ?? details.module,
    'Record'
  )
  const recordId = stringValue(details.recordId ?? details.id)
  const recordName = stringValue(
    details.recordName ?? details.name,
    'Zoho record'
  )

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
      <div className="px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {recordType}{recordId ? ` · ${recordId}` : ''}
        </p>
        <p className="mt-1 truncate text-sm font-medium">{recordName}</p>
      </div>
      {changes.length > 0 ? (
        <>
          <Separator />
          <div className="flex flex-col">
            {changes.map((change, index) => (
              <div key={`${change.field}-${index}`}>
                {index > 0 ? <Separator /> : null}
                <div className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[104px_minmax(0,1fr)_20px_minmax(0,1fr)] sm:items-center">
                  <span className="text-muted-foreground">{change.field}</span>
                  {change.before ? (
                    <span className="truncate text-muted-foreground line-through decoration-border">
                      {change.before}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">New value</span>
                  )}
                  <ChevronRight className="hidden sm:block" />
                  <span className="truncate font-medium">{change.after}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <GenericRequest presentation={presentation} borderless />
      )}
    </div>
  )
}

function GenericRequest({
  presentation,
  borderless = false,
}: {
  presentation: Record<string, unknown>
  borderless?: boolean
}) {
  return (
    <div
      className={cn(
        'max-h-64 overflow-auto bg-background p-4',
        !borderless && 'rounded-xl border border-border/70'
      )}
    >
      <pre className="whitespace-pre-wrap break-words text-xs leading-5">
        {JSON.stringify(presentation, null, 2)}
      </pre>
    </div>
  )
}

function ExactRequestDetails({
  request,
}: {
  request: Exclude<PiPendingUiRequest, { protocol: 'memory-review' }>
}) {
  const [open, setOpen] = useState(false)
  const { descriptor } = request

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-between">
          <span className="flex items-center gap-2">
            {appKind(request) === 'gmail' ? <Mail /> : <FileText />}
            Inspect exact request
          </span>
          <ChevronDown
            data-icon="inline-end"
            className={cn('transition-transform', open && 'rotate-180')}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2 pt-1">
        <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[88px_minmax(0,1fr)]">
          {[
            ['Operation', descriptor.kind],
            ['Action', descriptor.action],
            ['Source', descriptor.source],
            ['Tool call', descriptor.toolCallId],
          ].map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}
