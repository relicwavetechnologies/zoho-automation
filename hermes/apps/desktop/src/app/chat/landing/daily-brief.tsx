/**
 * Landing "Your day" brief.
 *
 * Renders below the landing composer: a Lark-sourced summary of the user's
 * tasks (overdue / today / upcoming) + today's meetings, laid out as two
 * Lark-style list windows. Clicking a task or meeting row toggles it as a
 * reference chip on the composer; the "Summarize & plan my day" action seeds
 * a structured prompt (→ new session).
 *
 * Tasks come from the Divo Follow Ups client, which already merges Divo rows
 * with plain Lark tasks. Meetings remain mock-backed until the calendar seam
 * is wired. The scroll-reveal (parallax + blur) sharpens the panel as the user
 * scrolls it up into focus, and settles fully sharp at the bottom of scroll.
 */
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { followUpRecordToTask, getFollowUpsClient, type FollowUpsClient } from '@/lib/follow-ups'
import { followUpStatusLabel } from '@/lib/follow-ups/status-label'
import type { FollowUpTask } from '@/lib/follow-ups/types'
import { cn } from '@/lib/utils'

import type { LarkContextRef } from '@/lib/today-panel/context-ref'
import type { TaskGroup } from '@/lib/today-panel/map-brief'

export type { LarkContextRef as LandingRef } from '@/lib/today-panel/context-ref'

interface BriefTask {
  id: string
  title: string
  meta: string
  late?: boolean
  ownerLabel?: string
  tag?: string
  group: TaskGroup
}

interface BriefMeeting {
  id: string
  time: string
  title: string
  sub: string
  soon?: boolean
}

interface DailyBriefData {
  dateLabel: string
  tasks: BriefTask[]
  meetings: BriefMeeting[]
}

const MOCK: DailyBriefData = {
  dateLabel: 'Mon, Jun 15',
  tasks: [
    { id: 't1', group: 'overdue', title: 'Send Q2 finance report to Aaron', meta: '2 days late', late: true, tag: 'Finance' },
    { id: 't2', group: 'overdue', title: 'Review vendor contract — Zoho renewal', meta: 'Yesterday', late: true, tag: 'Ops' },
    { id: 't3', group: 'today', title: 'Finalize Divo memory design doc', meta: '5:00 PM', tag: 'Divo' },
    { id: 't4', group: 'today', title: 'Reply to Aaron re: gateway rollout', meta: 'EOD', tag: 'Divo' },
    { id: 't5', group: 'today', title: 'Approve design tokens PR', meta: 'EOD', tag: 'Design' },
    { id: 't6', group: 'upcoming', title: 'Prep client demo deck', meta: 'Tomorrow', tag: 'Sales' }
  ],
  meetings: [
    { id: 'm1', time: '10:30', title: 'Eng standup', sub: '15m · Lark Meet' },
    { id: 'm2', time: '14:00', title: 'Design review', sub: '45m · 4 guests' },
    { id: 'm3', time: '16:30', title: '1:1 with Aaron', sub: '30m', soon: true },
    { id: 'm4', time: '18:00', title: 'Client demo — Acme', sub: '45m · 6 guests' }
  ]
}

function briefTaskFromFollowUpTask(task: FollowUpTask): BriefTask {
  const isFollowUp = task.lifecycleActions.isFollowUp
  const status = followUpStatusLabel(task.status)

  return {
    id: task.id,
    group: task.group,
    title: task.title,
    meta: task.dueLabel,
    late: task.group === 'overdue',
    ownerLabel: isFollowUp ? `From ${task.assignedBy}` : undefined,
    tag: isFollowUp ? task.delegatedTag ?? 'Divo Follow Up' : status
  }
}

function useDailyBriefData(client: FollowUpsClient): DailyBriefData {
  const [tasks, setTasks] = useState<BriefTask[] | null>(null)

  useEffect(() => {
    let cancelled = false

    void client
      .listTaskMetadata()
      .then(response => {
        if (!cancelled) {
          setTasks(response.tasks.map(record => briefTaskFromFollowUpTask(followUpRecordToTask(record))))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTasks(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [client])

  return {
    ...MOCK,
    tasks: tasks ?? MOCK.tasks
  }
}

const GROUP_LABEL: Record<TaskGroup, string> = { overdue: 'Overdue', today: 'Due today', upcoming: 'Upcoming' }
const GROUP_DOT: Record<TaskGroup, string> = { overdue: 'bg-[#b75464]', today: 'bg-[#eab064]', upcoming: 'bg-[#4a4a4a]' }
const GROUP_ORDER: TaskGroup[] = ['overdue', 'today', 'upcoming']

/** Build the structured "run my day" prompt the composer is seeded with. */
function buildDayPrompt(data: DailyBriefData, scope: 'all' | 'overdue'): string {
  const byGroup = (g: TaskGroup) => data.tasks.filter(t => t.group === g)
  const lines: string[] = []

  if (scope === 'overdue') {
    lines.push('I have overdue Lark tasks — help me clear them fast.', '')
    lines.push('[OVERDUE]')
    byGroup('overdue').forEach(t => lines.push(`- ${t.title} — ${t.meta}`))
    lines.push('', 'For each: the single fastest next action, and draft any message I need to send.')

    return lines.join('\n')
  }

  lines.push("Here's my day from Lark — help me run it.", '')
  const overdue = byGroup('overdue')

  if (overdue.length) {
    lines.push(`[OVERDUE · ${overdue.length}]`)
    overdue.forEach(t => lines.push(`- ${t.title} — ${t.meta}`))
    lines.push('')
  }

  const today = byGroup('today')

  if (today.length) {
    lines.push(`[DUE TODAY · ${today.length}]`)
    today.forEach(t => lines.push(`- ${t.title} — ${t.meta}`))
    lines.push('')
  }

  if (data.meetings.length) {
    lines.push(`[MEETINGS · ${data.meetings.length}]`)
    data.meetings.forEach(m => lines.push(`- ${m.time} ${m.title} (${m.sub})`))
    lines.push('')
  }

  lines.push(
    'Please:',
    '1. Order what I should tackle first, around the meetings.',
    "2. Flag anything that collides or won't fit before EOD.",
    "3. Draft a 2-line reply for anything I'm blocking (esp. Aaron)."
  )

  return lines.join('\n')
}

// ── Blur reveal: the brief is soft/dim while it peeks at the bottom, and
// sharpens as the page scrolls it up into its locked position. Blur + opacity
// ONLY — no transform — so it never slides under the composer. The inner window
// lists scroll independently (that doesn't move the outer scroller, so a
// locked brief stays sharp while you scroll its lists).
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

function useBriefBlur(briefRef: RefObject<HTMLElement | null>, scrollRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const brief = briefRef.current
    const scroller = scrollRef.current

    if (!brief || !scroller) {
      return
    }

    let raf = 0

    const frame = () => {
      raf = 0
      const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight)
      const p = clamp(scroller.scrollTop / max, 0, 1) // 0 = peeking at bottom, 1 = locked
      brief.style.filter = p >= 0.99 ? 'none' : `blur(${(6 * (1 - p)).toFixed(2)}px)`
      brief.style.opacity = (0.5 + 0.5 * p).toFixed(3)
    }

    const onScroll = () => {
      if (!raf) {
        raf = requestAnimationFrame(frame)
      }
    }

    frame()
    scroller.addEventListener('scroll', onScroll, { passive: true })

    const ro = new ResizeObserver(frame)
    ro.observe(scroller)

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      ro.disconnect()

      if (raf) {
        cancelAnimationFrame(raf)
      }
    }
  }, [briefRef, scrollRef])
}

// ── Lark-style window shell ─────────────────────────────────────────────────
const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'
const HAIRLINE = 'border-[color-mix(in_srgb,var(--foreground)_10%,transparent)]'

/** A framed list "window" echoing Lark's Tasks/Calendar list view. */
function LarkWindow({
  children,
  className,
  count,
  dueLabel,
  icon,
  tabs,
  title
}: {
  children: ReactNode
  className?: string
  count: number
  dueLabel: string
  icon: string
  tabs: [string, string]
  title: string
}) {
  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-[#141414]', PANEL_BORDER, className)}>
      {/* title bar (fixed) */}
      <div className={cn('flex shrink-0 items-center gap-2 border-b bg-[#191919] px-3 py-2', HAIRLINE)}>
        <Codicon className="text-(--ui-text-tertiary)" name={icon} size="0.85rem" />
        <span className="text-[12.5px] font-semibold text-[#dcdcdc]">{title}</span>
        <span className="text-[11px] tabular-nums text-(--ui-text-tertiary)">{count}</span>
        <div className={cn('ml-2 flex items-center gap-0.5 rounded-md bg-[#0f0f0f] p-0.5', PANEL_BORDER)}>
          <span className="flex items-center gap-1 rounded-[5px] bg-[#262626] px-1.5 py-0.5 text-[10.5px] font-medium text-[#dcdcdc]">
            <Codicon name="list-flat" size="0.7rem" /> {tabs[0]}
          </span>
          <span className="flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10.5px] text-(--ui-text-tertiary)">
            <Codicon name="layout" size="0.7rem" /> {tabs[1]}
          </span>
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-(--ui-text-tertiary)">
          <Codicon className="rounded p-0.5 transition-colors hover:bg-[#202020] hover:text-foreground" name="add" size="0.8rem" />
          <Codicon className="rounded p-0.5 transition-colors hover:bg-[#202020] hover:text-foreground" name="ellipsis" size="0.8rem" />
        </span>
      </div>
      {/* column header (fixed) */}
      <div className={cn('flex shrink-0 items-center border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-(--ui-text-tertiary)', HAIRLINE)}>
        <span className="flex-1">{title === 'Meetings' ? 'Meeting' : 'Task title'}</span>
        <span className="flex shrink-0 items-center gap-1">
          <Codicon name="calendar" size="0.7rem" /> {dueLabel}
        </span>
      </div>
      {/* list — scrolls inside the locked window */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  )
}

/** Trailing affordance that shows the row's reference state. */
function RefMark({ referenced }: { referenced: boolean }) {
  return (
    <span
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-md text-[0.8rem] transition',
        referenced
          ? 'bg-[#cd9883] text-[#1a120e]'
          : 'text-(--ui-text-tertiary) opacity-0 group-hover/row:opacity-100'
      )}
    >
      <Codicon name={referenced ? 'check' : 'add'} size="0.8rem" />
    </span>
  )
}

// ── Component ───────────────────────────────────────────────────────────────
export function DailyBrief({
  className,
  followUpsClient,
  onToggleReference,
  onUsePrompt,
  referencedIds,
  scrollRef
}: {
  className?: string
  followUpsClient?: FollowUpsClient
  onToggleReference: (ref: LarkContextRef) => void
  onUsePrompt: (prompt: string) => void
  referencedIds: ReadonlySet<string>
  scrollRef: RefObject<HTMLElement | null>
}) {
  const client = useMemo(() => followUpsClient ?? getFollowUpsClient(), [followUpsClient])
  const data = useDailyBriefData(client)
  const briefRef = useRef<HTMLDivElement>(null)
  useBriefBlur(briefRef, scrollRef)

  const [filter, setFilter] = useState<TaskGroup | 'meetings' | null>(null)
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set())

  const counts = useMemo(
    () => ({
      overdue: data.tasks.filter(t => t.group === 'overdue').length,
      today: data.tasks.filter(t => t.group === 'today').length,
      meetings: data.meetings.length
    }),
    [data]
  )

  const toggleDone = (id: string) =>
    setDone(prev => {
      const next = new Set(prev)

      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }

      return next
    })

  const tasksDimmed = filter === 'meetings'
  const meetingsDimmed = filter !== null && filter !== 'meetings'

  return (
    <div
      className={cn('flex min-h-0 flex-col overflow-hidden rounded-2xl bg-[#151515]', PANEL_BORDER, 'shadow-[0_12px_40px_rgba(0,0,0,0.35)]', className)}
      ref={briefRef}
    >
      {/* header (fixed) */}
      <div className="flex shrink-0 items-center gap-3 px-[18px] pb-3 pt-4">
        <div className="text-[0.95rem] font-semibold text-[#e6e6e6]">
          Your day <span className="font-normal text-(--ui-text-tertiary)">· {data.dateLabel}</span>
        </div>
        <span className={cn('ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-(--ui-text-tertiary)', PANEL_BORDER)}>
          <Codicon name="sync" size="0.8rem" /> Synced from Lark
        </span>
      </div>

      {/* stat chips — also act as filters (fixed) */}
      <div className="flex shrink-0 gap-2.5 px-[18px] pb-3.5">
        {(
          [
            ['overdue', counts.overdue, 'Overdue', 'text-[#e0697a]'],
            ['today', counts.today, 'Due today', 'text-[#eab064]'],
            ['meetings', counts.meetings, 'Meetings', 'text-[#7fa9cf]']
          ] as const
        ).map(([key, n, label, tone]) => (
          <button
            className={cn(
              'flex flex-1 flex-col items-start gap-0.5 rounded-xl bg-[#171717] px-3 py-2.5 text-left',
              PANEL_BORDER,
              'transition-colors hover:bg-[#1b1b1b]',
              filter === key && 'border-[color-mix(in_srgb,#cd9883_50%,transparent)] bg-[#1d1a18]'
            )}
            key={key}
            onClick={() => setFilter(f => (f === key ? null : key))}
            type="button"
          >
            <b className={cn('text-[1.25rem] leading-none font-bold', tone)}>{n}</b>
            <span className="text-xs text-(--ui-text-tertiary)">{label}</span>
          </button>
        ))}
      </div>

      {/* hint (fixed) */}
      <div className="shrink-0 px-[18px] pb-2 text-[11px] text-(--ui-text-tertiary)">
        Tap a task or meeting to add it as context for the chat.
      </div>

      {/* two Lark-style windows — the row fills the remaining height; each
          window's list scrolls internally so the brief itself stays locked. */}
      <div className="flex min-h-0 flex-1 gap-3 px-[18px] pb-4">
        {/* tasks window */}
        <LarkWindow
          className={cn('min-h-0 flex-[1.3] transition-opacity', tasksDimmed && 'opacity-30')}
          count={data.tasks.length}
          dueLabel="Due"
          icon="checklist"
          tabs={['List', 'Kanban']}
          title="Tasks"
        >
          <div className="px-1.5 py-1.5">
            {GROUP_ORDER.map(group => {
              const items = data.tasks.filter(t => t.group === group)

              if (!items.length || (filter === 'meetings' ? false : filter !== null && filter !== group)) {
                return null
              }

              return (
                <div className="mb-0.5" key={group}>
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-semibold text-(--ui-text-tertiary)">
                    <Codicon name="chevron-down" size="0.7rem" />
                    <span className={cn('size-1.5 rounded-full', GROUP_DOT[group])} /> {GROUP_LABEL[group]}
                    <span className="tabular-nums">· {items.length}</span>
                  </div>
                  {items.map(t => {
                    const isDone = done.has(t.id)
                    const referenced = referencedIds.has(t.id)

                    return (
                      <button
                        className={cn(
                          'group/row flex w-full items-center gap-2.5 border-l-2 px-2 py-1.5 text-left transition-colors hover:bg-[#191919]',
                          referenced ? 'border-l-[#cd9883] bg-[#1d1a18]' : 'border-l-transparent'
                        )}
                        key={t.id}
                        onClick={() =>
                          onToggleReference({
                            id: t.id,
                            kind: 'task',
                            label: t.title,
                            detail: t.meta,
                            larkRef: `@lark-task:${t.id}`
                          })
                        }
                        type="button"
                      >
                        <span
                          aria-checked={isDone}
                          aria-label={isDone ? 'Mark not done' : 'Mark done'}
                          className={cn(
                            'grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors',
                            isDone ? 'border-[#6fc08a] bg-[#6fc08a] text-[#10210f]' : 'border-[#3a3a3a] hover:border-[#cd9883]'
                          )}
                          onClick={e => {
                            e.stopPropagation()
                            toggleDone(t.id)
                          }}
                          role="checkbox"
                        >
                          {isDone && <Codicon name="check" size="0.62rem" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn('block truncate text-[13px] leading-snug text-[#dcdcdc]', isDone && 'text-(--ui-text-tertiary) line-through')}>
                            {t.title}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            {t.ownerLabel && (
                              <span className="truncate text-[10.5px] text-(--ui-text-tertiary)">
                                {t.ownerLabel}
                              </span>
                            )}
                            {t.tag && (
                              <span className={cn('inline-block rounded border px-1.5 text-[10px] text-(--ui-text-tertiary)', HAIRLINE)}>{t.tag}</span>
                            )}
                          </span>
                        </span>
                        <span className={cn('shrink-0 text-[11.5px] tabular-nums', t.late ? 'text-[#e0697a]' : 'text-(--ui-text-tertiary)')}>
                          {t.meta}
                        </span>
                        <RefMark referenced={referenced} />
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </LarkWindow>

        {/* meetings window */}
        <LarkWindow
          className={cn('min-h-0 flex-1 transition-opacity', meetingsDimmed && 'opacity-30')}
          count={data.meetings.length}
          dueLabel="Time"
          icon="calendar"
          tabs={['List', 'Day']}
          title="Meetings"
        >
          <div className="px-1.5 py-1.5">
            {data.meetings.map(m => {
              const referenced = referencedIds.has(m.id)

              return (
                <button
                  className={cn(
                    'group/row flex w-full items-center gap-2.5 border-l-2 px-2 py-2 text-left transition-colors hover:bg-[#191919]',
                    referenced ? 'border-l-[#cd9883] bg-[#1d1a18]' : 'border-l-transparent'
                  )}
                  key={m.id}
                  onClick={() =>
                    onToggleReference({
                      id: m.id,
                      kind: 'meeting',
                      label: m.title,
                      detail: `${m.time} · ${m.sub}`,
                      larkRef: `@lark-event:${m.id}`
                    })
                  }
                  type="button"
                >
                  <span className="w-[44px] shrink-0 text-[12.5px] font-semibold tabular-nums text-[#bcbcbc]">{m.time}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-[#dcdcdc]">{m.title}</span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-(--ui-text-tertiary)">{m.sub}</span>
                  </span>
                  {m.soon && (
                    <span className="shrink-0 rounded border border-[color-mix(in_srgb,#6fc08a_40%,transparent)] px-1.5 text-[10px] text-[#6fc08a]">soon</span>
                  )}
                  <RefMark referenced={referenced} />
                </button>
              )
            })}
          </div>
        </LarkWindow>
      </div>

      {/* actions (fixed) */}
      <div className={cn('flex shrink-0 flex-wrap items-center gap-2.5 border-t bg-[#131313] px-[18px] py-3.5', HAIRLINE)}>
        <button
          className="rounded-[10px] bg-[#cd9883] px-4 py-2.5 text-[13px] font-semibold text-[#1a120e] transition-colors hover:bg-[#d8a78f]"
          onClick={() => onUsePrompt(buildDayPrompt(data, 'all'))}
          type="button"
        >
          ✦ Summarize &amp; plan my day <span className="opacity-60">→</span>
        </button>
        <button
          className={cn('rounded-[10px] px-4 py-2.5 text-[13px] font-semibold text-(--ui-text-tertiary)', PANEL_BORDER, 'transition-colors hover:bg-[#1b1b1b] hover:text-foreground')}
          onClick={() => onUsePrompt(buildDayPrompt(data, 'overdue'))}
          type="button"
        >
          Just the overdue
        </button>
        <span className="ml-auto text-[11.5px] text-(--ui-text-tertiary)">opens in the composer</span>
      </div>
    </div>
  )
}
