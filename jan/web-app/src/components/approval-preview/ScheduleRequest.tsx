import {
  CalendarClock,
  CirclePause,
  CirclePlay,
  CircleX,
  Repeat,
  Zap,
} from 'lucide-react'
import type { ComponentType } from 'react'

import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/**
 * Scheduling gets its own accent — amber, not a vendor blue. A schedule is not
 * an action in someone else's app; it is Divo agreeing to act on its own later.
 */
const SCHEDULE_ACCENT_TEXT = 'text-amber-700 dark:text-amber-300'
const SCHEDULE_ACCENT_SOFT =
  'bg-amber-500/[0.09] dark:bg-amber-400/[0.12] border-amber-500/25 dark:border-amber-300/25'

/** The scheduler operations the backend tool accepts. */
export type ScheduleOperation =
  | 'create'
  | 'list'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'run_now'

const OPERATION_META: Record<
  ScheduleOperation,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  create: { label: 'New scheduled work', icon: CalendarClock },
  list: { label: 'Scheduled work', icon: CalendarClock },
  pause: { label: 'Pause scheduled work', icon: CirclePause },
  resume: { label: 'Resume scheduled work', icon: CirclePlay },
  cancel: { label: 'Cancel scheduled work', icon: CircleX },
  run_now: { label: 'Run scheduled work now', icon: Zap },
}

/** What each management operation actually does, stated plainly. */
const OPERATION_EFFECT: Partial<Record<ScheduleOperation, string>> = {
  pause: 'This schedule stops running until it is resumed. It is not deleted.',
  resume: 'This schedule starts running on its normal cadence again.',
  cancel: 'This schedule is cancelled and will not run again.',
  run_now: 'This schedule runs once immediately, in addition to its cadence.',
}

const DAY_NAMES: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
}

function str(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function num(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** 24h clock fields into the 12h wording the user typed in the first place. */
export function formatClock(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display}:${String(minute).padStart(2, '0')} ${suffix}`
}

function ordinal(day: number): string {
  const rem100 = day % 100
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`
  switch (day % 10) {
    case 1:
      return `${day}st`
    case 2:
      return `${day}nd`
    case 3:
      return `${day}rd`
    default:
      return `${day}th`
  }
}

function joinDays(days: string[]): string {
  const names = days.map((day) => DAY_NAMES[day.toUpperCase()] ?? day)
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

/**
 * The cadence in one plain-English line — the single thing a reviewer is
 * actually approving. Returns '' when the shape is unrecognised rather than
 * guessing: a wrong cadence here would be approved as if it were right.
 */
export function formatCadence(details: Record<string, unknown>): string {
  const scheduleType = str(details, 'scheduleType', 'schedule_type')
  const hour = num(details, 'hour')
  const timeMinute = num(details, 'timeMinute', 'time_minute')
  const at =
    hour !== undefined && timeMinute !== undefined
      ? formatClock(hour, timeMinute)
      : ''

  switch (scheduleType) {
    case 'one_time': {
      const runAt = str(details, 'runAt', 'run_at')
      if (!runAt) return 'Once'
      const parsed = new Date(runAt)
      if (Number.isNaN(parsed.getTime())) return `Once at ${runAt}`
      // Rendered in the schedule's OWN timezone, which is shown beside it —
      // the reviewer set the schedule in that zone, not in the browser's.
      const timezone = str(details, 'timezone')
      try {
        return `Once on ${parsed.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
          ...(timezone ? { timeZone: timezone } : {}),
        })}`
      } catch {
        return `Once on ${parsed.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}`
      }
    }
    case 'hourly': {
      const every = num(details, 'intervalHours', 'interval_hours') ?? 1
      const minute = num(details, 'minute') ?? 0
      const past = `at :${String(minute).padStart(2, '0')}`
      return every === 1
        ? `Every hour ${past}`
        : `Every ${every} hours ${past}`
    }
    case 'daily':
      return at ? `Every day at ${at}` : 'Every day'
    case 'weekly': {
      const days = Array.isArray(details.daysOfWeek)
        ? details.daysOfWeek.filter(
            (day): day is string => typeof day === 'string'
          )
        : []
      const when = days.length > 0 ? `Every ${joinDays(days)}` : 'Every week'
      return at ? `${when} at ${at}` : when
    }
    case 'monthly': {
      const day = num(details, 'dayOfMonth', 'day_of_month')
      const when =
        day !== undefined
          ? `Monthly on the ${ordinal(day)}`
          : 'Monthly'
      return at ? `${when} at ${at}` : when
    }
    default:
      return ''
  }
}

/** Fields the card renders itself, so the fallback list can skip them. */
const CONSUMED_KEYS = new Set([
  'operation',
  'op',
  'name',
  'intent',
  'timezone',
  'scheduleType',
  'schedule_type',
  'runAt',
  'run_at',
  'hour',
  'timeMinute',
  'time_minute',
  'minute',
  'intervalHours',
  'interval_hours',
  'daysOfWeek',
  'days_of_week',
  'dayOfMonth',
  'day_of_month',
  'scheduleId',
  'schedule_id',
])

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-[104px_minmax(0,1fr)]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  )
}

/**
 * Approval preview for Divo's own scheduler.
 *
 * A schedule is the one approval where the action is not what happens now — it
 * is a standing grant to act later, unattended and repeatedly. So the card
 * leads with the cadence, shows the full intent that will run on every firing,
 * and says plainly that nobody will be watching. Anything the card does not
 * recognise still appears as a labelled row: an approval screen must never
 * omit part of what is being approved.
 */
export function ScheduleRequest({
  presentation,
}: {
  presentation: Record<string, unknown>
}) {
  const raw = presentation.details
  const details =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : presentation

  const rawOperation = str(details, 'operation', 'op').toLowerCase()
  const operation = (
    rawOperation in OPERATION_META ? rawOperation : 'create'
  ) as ScheduleOperation
  const { label, icon: OperationIcon } = OPERATION_META[operation]

  const name = str(details, 'name')
  const intent = str(details, 'intent')
  const timezone = str(details, 'timezone')
  const scheduleId = str(details, 'scheduleId', 'schedule_id')
  const cadence = formatCadence(details)
  const scheduleType = str(details, 'scheduleType', 'schedule_type')
  const recurring = scheduleType !== '' && scheduleType !== 'one_time'
  const effect = OPERATION_EFFECT[operation]

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
          SCHEDULE_ACCENT_SOFT,
          SCHEDULE_ACCENT_TEXT
        )}
      >
        <OperationIcon className="size-3.5" />
        {label}
      </div>

      <div className="px-4 py-3">
        {name ? (
          <p className="break-words text-sm font-medium">{name}</p>
        ) : operation === 'create' ? (
          <p className="text-sm text-muted-foreground">Unnamed schedule</p>
        ) : null}

        {/* The cadence is the headline: it is what actually gets granted. */}
        {cadence ? (
          <p
            className={cn(
              'mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-medium',
              SCHEDULE_ACCENT_TEXT
            )}
            data-testid="schedule-cadence"
          >
            {recurring ? <Repeat className="size-4 shrink-0" /> : null}
            {cadence}
            {timezone ? (
              <span className="text-xs font-normal text-muted-foreground">
                {timezone}
              </span>
            ) : null}
          </p>
        ) : null}

        {effect ? (
          <p className="mt-2 text-sm text-muted-foreground">{effect}</p>
        ) : null}

        {scheduleId ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {scheduleId}
          </p>
        ) : null}
      </div>

      {intent ? (
        <>
          <Separator />
          <div className="px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {recurring ? 'Divo runs this every time' : 'Divo runs this'}
            </p>
            {/* Capped and scrollable: intent allows up to 10k characters, and
                a card that grows past the viewport pushes the approve button
                out of reach. */}
            <div className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words text-sm leading-6">
              {intent}
            </div>
          </div>
        </>
      ) : null}

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

      {operation === 'create' && recurring ? (
        <>
          <Separator />
          <p className="px-4 py-2.5 text-xs leading-5 text-muted-foreground">
            This runs on its own, without you watching, until you pause or
            cancel it. Each run can act with the permissions you have already
            granted.
          </p>
        </>
      ) : null}
    </div>
  )
}
