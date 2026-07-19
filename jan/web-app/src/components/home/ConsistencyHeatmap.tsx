import { useMemo } from 'react'

import { useThreads } from '@/hooks/useThreads'
import {
  buildConsistency,
  DEFAULT_WEEKS,
  threadActivitySeconds,
  type ConsistencyLevel,
} from '@/lib/consistency'
import { cn } from '@/lib/utils'

/** Empty → busiest. Tuned to stay legible on both themes. */
const LEVEL_CLASS: Record<ConsistencyLevel, string> = {
  0: 'bg-foreground/[0.06]',
  1: 'bg-primary/30',
  2: 'bg-primary/50',
  3: 'bg-primary/75',
  4: 'bg-primary',
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-foreground/[0.04] px-2.5 py-1.5">
      <p className="text-[11px] leading-none text-muted-foreground">{label}</p>
      <p className="mt-1 text-[13px] font-medium leading-none tabular-nums">
        {value}
      </p>
    </div>
  )
}

/**
 * @param weeks Week columns to show. Columns stretch to fill the card, so this
 *   also sets the cell size: fewer weeks means larger squares.
 */
export function ConsistencyHeatmap({
  weeks = DEFAULT_WEEKS,
}: {
  weeks?: number
} = {}) {
  const threads = useThreads((state) => state.threads)

  const consistency = useMemo(
    () =>
      buildConsistency(
        threadActivitySeconds(Object.values(threads ?? {})),
        Date.now(),
        weeks
      ),
    [threads, weeks]
  )

  const sessions = Object.keys(threads ?? {}).length

  return (
    <section
      className="mx-auto mt-8 w-full max-w-md rounded-xl bg-card/50 p-3"
      aria-label="Consistency"
      data-testid="consistency-heatmap"
    >
      {/* Tiles carry the numbers so the grid doesn't have to. Its only job is
          the shape of the activity — no headline, no legend beside it. */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Stat label="Sessions" value={String(sessions)} />
        <Stat label="Active days" value={String(consistency.activeDays)} />
        <Stat
          label="Current streak"
          value={`${consistency.currentStreak}d`}
        />
        <Stat
          label="Longest streak"
          value={`${consistency.longestStreak}d`}
        />
      </div>

      {/* Column-major over 7 rows: each column is one week, Sunday at the top.
          Columns stretch to the card, which is why the card itself is capped at
          `max-w-md` — unbounded, 16 `1fr` columns inflate into slabs. */}
      <div
        className="mt-1.5 grid grid-flow-col grid-rows-7 auto-cols-fr gap-[3px]"
        role="img"
        aria-label={`${consistency.activeDays} active days in the last ${weeks} weeks. Current streak ${plural(consistency.currentStreak, 'day')}. Longest streak ${plural(consistency.longestStreak, 'day')}.`}
      >
        {consistency.days.map((day) => (
          <div
            key={day.ms}
            title={
              day.isFuture
                ? undefined
                : `${plural(day.count, 'session')} · ${new Date(day.ms).toLocaleDateString(undefined, DAY_FORMAT)}`
            }
            className={cn(
              'aspect-square rounded-[3px]',
              day.isFuture ? 'opacity-0' : LEVEL_CLASS[day.level]
            )}
          />
        ))}
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground/70">
        {weeks >= 52 ? 'Last 12 months' : `Last ${weeks} weeks`} of activity.
      </p>
    </section>
  )
}
