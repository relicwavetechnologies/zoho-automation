import {
  CalendarClock,
  CheckCircle2,
  CircleCheck,
  FileText,
  MessageSquare,
  Table2,
  UserRound,
} from 'lucide-react'
import type { ComponentType } from 'react'

import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/**
 * Lark's brand blue, tuned per theme. The stock #3370FF is too heavy on a dark
 * surface, so dark mode lifts it; both sides stay legible against white text.
 */
const LARK_ACCENT = 'bg-[#3370FF] dark:bg-[#4E7FFF]'
const LARK_ACCENT_TEXT = 'text-[#2B5FE3] dark:text-[#7BA2FF]'
const LARK_ACCENT_SOFT =
  'bg-[#3370FF]/[0.08] dark:bg-[#7BA2FF]/[0.12] border-[#3370FF]/20 dark:border-[#7BA2FF]/25'

/** The Lark surface a gateway call is targeting. */
export type LarkSurface =
  | 'messaging'
  | 'task'
  | 'doc'
  | 'calendar'
  | 'base'
  | 'approval'
  | 'contacts'
  | 'generic'

const SURFACE_META: Record<
  LarkSurface,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  messaging: { label: 'Lark Messenger', icon: MessageSquare },
  task: { label: 'Lark Tasks', icon: CircleCheck },
  doc: { label: 'Lark Docs', icon: FileText },
  calendar: { label: 'Lark Calendar', icon: CalendarClock },
  base: { label: 'Lark Base', icon: Table2 },
  approval: { label: 'Lark Approval', icon: CheckCircle2 },
  contacts: { label: 'Lark Contacts', icon: UserRound },
  generic: { label: 'Lark', icon: MessageSquare },
}

/**
 * Which Lark app a request targets, from the descriptor identity (e.g.
 * `generic.larkDoc.create`). Meetings fold into calendar — they are the same
 * surface to a reviewer.
 */
export function larkSurface(identity: string): LarkSurface {
  const key = identity.toLowerCase()
  if (key.includes('larkmessag') || key.includes('larkchat')) return 'messaging'
  if (key.includes('larktask')) return 'task'
  if (key.includes('larkdoc')) return 'doc'
  if (key.includes('larkcalendar') || key.includes('larkmeeting')) {
    return 'calendar'
  }
  if (key.includes('larkbase')) return 'base'
  if (key.includes('larkapproval')) return 'approval'
  if (key.includes('larkcontact')) return 'contacts'
  return 'generic'
}

function str(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/** Rows the surface views already render, so the fallback list can skip them. */
const CONSUMED_KEYS = new Set([
  'op',
  'connectionId',
  'title',
  'name',
  'subject',
  'text',
  'message',
  'content',
  'body',
  'to',
  'chat',
  'chatName',
  'receiver',
  'recipient',
  'assignee',
  'owner',
  'due',
  'dueDate',
  'start',
  'startTime',
  'end',
  'endTime',
  'description',
  'summary',
])

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-[92px_minmax(0,1fr)]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  )
}

/**
 * Lark-flavoured approval preview. Shapes the pending action the way the Lark
 * app itself would show it — an outgoing chat bubble, a task row, a doc header
 * — so a reviewer recognises what is about to happen without reading JSON.
 *
 * Every surface degrades to a labelled key/value list rather than hiding
 * fields: an approval screen must never omit part of what it is approving.
 */
export function LarkRequest({
  presentation,
  identity,
}: {
  presentation: Record<string, unknown>
  identity: string
}) {
  const raw = presentation.details
  const details =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : presentation

  const surface = larkSurface(identity)
  const { label, icon: SurfaceIcon } = SURFACE_META[surface]

  const title = str(details, 'title', 'name', 'subject')
  const message = str(details, 'text', 'message', 'content', 'body')
  const target = str(details, 'to', 'chatName', 'chat', 'receiver', 'recipient')
  const assignee = str(details, 'assignee', 'owner')
  const due = str(details, 'due', 'dueDate')
  const start = str(details, 'start', 'startTime')
  const end = str(details, 'end', 'endTime')
  const description = str(details, 'description', 'summary')

  const extras = Object.entries(details).filter(
    ([key, value]) =>
      !CONSUMED_KEYS.has(key) &&
      (typeof value === 'string' || typeof value === 'number') &&
      String(value).trim() !== ''
  )

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
      <div
        className={cn(
          'flex items-center gap-2 border-b px-4 py-2 text-xs font-medium',
          LARK_ACCENT_SOFT,
          LARK_ACCENT_TEXT
        )}
      >
        <SurfaceIcon className="size-3.5" />
        {label}
      </div>

      {surface === 'messaging' ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          {target ? (
            <p className="text-xs text-muted-foreground">To {target}</p>
          ) : null}
          {message ? (
            <div className="flex justify-end">
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-sm leading-6 text-white',
                  LARK_ACCENT
                )}
              >
                {message}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No message body.</p>
          )}
        </div>
      ) : surface === 'task' ? (
        <div className="flex items-start gap-3 px-4 py-3">
          <span className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-muted-foreground/40" />
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium">
              {title || 'Untitled task'}
            </p>
            {description ? (
              <p className="mt-1 break-words text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
            {assignee || due ? (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {assignee ? <span>Assignee · {assignee}</span> : null}
                {due ? <span>Due · {due}</span> : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : surface === 'calendar' ? (
        <div className="px-4 py-3">
          <p className="break-words text-sm font-medium">
            {title || 'Untitled event'}
          </p>
          {start || end ? (
            <p className={cn('mt-1 text-sm', LARK_ACCENT_TEXT)}>
              {[start, end].filter(Boolean).join(' → ')}
            </p>
          ) : null}
          {description ? (
            <p className="mt-2 break-words text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="px-4 py-3">
          <p className="break-words text-sm font-medium">
            {title || 'Untitled item'}
          </p>
          {description ? (
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
          {message ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
              {message}
            </p>
          ) : null}
        </div>
      )}

      {extras.length > 0 ? (
        <>
          <Separator />
          <div className="flex flex-col">
            {extras.map(([key, value], index) => (
              <div key={key}>
                {index > 0 ? <Separator /> : null}
                <MetaRow label={key} value={String(value)} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
