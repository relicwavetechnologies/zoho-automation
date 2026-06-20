import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'

import type { FollowUpRecord } from '@/lib/follow-ups/api-types'
import {
  contextRefFromDoc,
  contextRefFromMeeting,
  contextRefFromNeedsYou,
  contextRefFromTask,
  type LarkContextRef,
  type TaskGroup
} from '@/lib/today-panel'
import type { TodayActiveFollowUp, TodayDocItem, TodayMeeting, TodayNeedsYouItem } from '@/lib/today-panel/api-types'
import { cn } from '@/lib/utils'

const PANEL_BORDER = 'border border-[color-mix(in_srgb,var(--foreground)_8%,transparent)]'
const GROUP_DOT: Record<TaskGroup, string> = {
  overdue: 'bg-[#e0697a]',
  today: 'bg-[#eab064]',
  upcoming: 'bg-[#4a4a4a]'
}
const GROUP_LABEL: Record<TaskGroup, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  upcoming: 'Upcoming'
}
const GROUP_ORDER: TaskGroup[] = ['overdue', 'today', 'upcoming']

export interface TodayPanelProps {
  className?: string
  dateLabel: string
  syncedAt?: string
  tasks: Array<{
    id: string
    title: string
    meta: string
    late?: boolean
    tag?: string
    group: TaskGroup
  }>
  meetings: Array<{ id: string; time: string; title: string; sub: string; soon?: boolean }>
  counts: { overdue: number; today: number; meetings: number }
  nextMeeting: TodayMeeting | null
  activeFollowUps: TodayActiveFollowUp[]
  needsYou: TodayNeedsYouItem[]
  docs: TodayDocItem[]
  referencedIds: ReadonlySet<string>
  loading?: boolean
  syncState?: 'loading' | 'synced' | 'error' | 'idle'
  onToggleReference: (ref: LarkContextRef) => void
  onUsePrompt: (prompt: string) => void
  onAssignFollowUp?: () => void
  onActiveLifecycle?: (action: 'pause' | 'updateDoc' | 'done', followUpId: string) => void
  taskRecordsById: Map<string, FollowUpRecord>
  meetingsById: Map<string, TodayMeeting>
  onSummarizeDay: () => void
}

function PanelCard({
  label,
  count,
  children,
  className
}: {
  label: string
  count?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('overflow-hidden rounded-[13px] bg-[#161616]', PANEL_BORDER, className)}>
      <div className="flex items-center justify-between border-b border-[#242424] px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[#666]">{label}</span>
        {count ? <span className="text-[10px] font-medium text-[#888]">{count}</span> : null}
      </div>
      {children}
    </div>
  )
}

function SelectableRow({
  selected,
  onClick,
  children,
  className
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      className={cn(
        'w-full border-b border-[#222] px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[#1a1a1a]',
        selected && 'bg-[#1d1d1d]',
        className
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

export function TodayPanel({
  className,
  dateLabel,
  syncedAt,
  tasks,
  meetings,
  counts,
  nextMeeting,
  activeFollowUps,
  needsYou,
  docs,
  referencedIds,
  loading,
  syncState = 'idle',
  onToggleReference,
  onUsePrompt,
  onAssignFollowUp,
  onActiveLifecycle,
  taskRecordsById,
  meetingsById,
  onSummarizeDay
}: TodayPanelProps) {
  const [filter, setFilter] = useState<TaskGroup | 'meetings' | null>(null)

  const tasksDimmed = filter === 'meetings'
  const meetingsDimmed = filter !== null && filter !== 'meetings'

  const groupedTasks = useMemo(() => {
    const groups = new Map<TaskGroup, typeof tasks>()
    for (const group of GROUP_ORDER) {
      const rows = tasks.filter(task => task.group === group)
      if (rows.length) {
        groups.set(group, rows)
      }
    }
    return groups
  }, [tasks])

  const toggleTask = (taskId: string) => {
    const record = taskRecordsById.get(taskId)
    if (!record) {
      return
    }
    onToggleReference(contextRefFromTask(record))
  }

  return (
    <section
      className={cn(
        '@container/today flex h-full min-h-0 flex-col overflow-hidden bg-[#101010]',
        className
      )}
      data-slot="today-panel"
    >
      <div className="shrink-0 px-4 pt-4 pr-[calc(var(--titlebar-tools-right,0.75rem)+var(--titlebar-tools-width,3.75rem))]">
        <div className="mb-3 flex flex-col gap-2 @min-[22rem]/today:flex-row @min-[22rem]/today:items-center">
          <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.02em] text-[#e6e6e6]">
            Your day <span className="font-normal text-(--ui-text-tertiary)">· {dateLabel}</span>
          </h2>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 @min-[22rem]/today:ml-auto @min-[22rem]/today:justify-end">
            <span
              className={cn(
                'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10.5px] text-(--ui-text-tertiary)',
                PANEL_BORDER
              )}
              title={
                syncState === 'error'
                  ? 'Lark sync failed'
                  : syncState === 'loading'
                    ? 'Syncing from Lark…'
                    : syncedAt
              }
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  syncState === 'error'
                    ? 'bg-[#e0697a]'
                    : syncState === 'loading'
                      ? 'bg-[#eab064] animate-pulse'
                      : 'bg-[#6fc08a] shadow-[0_0_6px_rgba(111,192,138,0.5)]'
                )}
              />
              <span className="truncate @max-[21rem]/today:sr-only">
                {syncState === 'error'
                  ? 'Sync failed'
                  : syncState === 'loading'
                    ? 'Syncing…'
                    : 'Synced from Lark'}
              </span>
            </span>
            {onAssignFollowUp ? (
              <button
                aria-label="Assign follow-up"
                className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)] bg-[#1a1a1a] px-2 py-1.5 text-[11px] font-medium text-[#d0d0d0] hover:bg-[#222] @min-[21rem]/today:px-2.5"
                onClick={onAssignFollowUp}
                type="button"
              >
                <span className="@max-[21rem]/today:sr-only">+ Assign follow-up</span>
                <span aria-hidden className="@min-[21rem]/today:hidden">
                  +
                </span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="mb-3 grid grid-cols-3 gap-2">
          {(
            [
              ['overdue', counts.overdue, 'Overdue', 'text-[#e0697a]'],
              ['today', counts.today, 'Due today', 'text-[#eab064]'],
              ['meetings', counts.meetings, 'Meetings', 'text-[#7fa9cf]']
            ] as const
          ).map(([key, n, label, tone]) => (
            <button
              className={cn(
                'rounded-xl border bg-[#171717] px-3 py-2.5 text-left',
                PANEL_BORDER,
                'hover:bg-[#1b1b1b]',
                filter === key && 'border-[color-mix(in_srgb,#cd9883_45%,transparent)] bg-[#1d1a18]'
              )}
              key={key}
              onClick={() => setFilter(current => (current === key ? null : key))}
              type="button"
            >
              <b className={cn('block text-[1.25rem] leading-none font-bold', tone)}>{n}</b>
              <span className="text-xs text-(--ui-text-tertiary)">{label}</span>
            </button>
          ))}
        </div>

        <p className="mb-2 text-[10.5px] text-[#555]">Tap any row to pin it as composer context.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        <div className="grid gap-2.5 @md/today:grid-cols-2">
          {nextMeeting ? (
            <div className={cn(meetingsDimmed && 'opacity-35', !meetingsDimmed && 'contents')}>
              <button
                className={cn(
                  'rounded-[13px] border border-[color-mix(in_srgb,#7fa9cf_25%,transparent)] bg-gradient-to-br from-[#161a1f] to-[#161616] p-3.5 text-left hover:from-[#1a1f26] hover:to-[#1a1a1a]',
                  referencedIds.has(nextMeeting.id) && 'border-[color-mix(in_srgb,#7fa9cf_50%,transparent)]',
                  meetingsDimmed && 'pointer-events-none'
                )}
                onClick={() => onToggleReference(contextRefFromMeeting(nextMeeting))}
                type="button"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#7fa9cf]">
                  <span>Next meeting</span>
                  {nextMeeting.soon ? <span className="ml-auto text-[#6fc08a] normal-case">Now</span> : null}
                </div>
                <div className="text-sm font-medium text-[#e8e8e8]">{nextMeeting.title}</div>
                <div className="mt-1 text-[11px] text-[#777]">
                  {nextMeeting.time} · {nextMeeting.sub}
                </div>
                {nextMeeting.vcUrl ? (
                  <div className="mt-2 flex gap-1.5">
                    <span className="rounded-md border border-[#2f2f2f] bg-[#1e1e1e] px-2 py-1 text-[10.5px] text-[#b8d4ef]">
                      Join VC
                    </span>
                  </div>
                ) : null}
              </button>
            </div>
          ) : null}

          {activeFollowUps.length > 0 ? (
            <div className={cn(tasksDimmed && 'opacity-35', !tasksDimmed && activeFollowUps.length === 1 && !nextMeeting && 'col-span-full')}>
              <div
                className={cn(
                  'rounded-[13px] border border-[color-mix(in_srgb,#6fc08a_20%,transparent)] bg-[#161616] p-3',
                  tasksDimmed && 'pointer-events-none'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-[#6fc08a]" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] font-medium text-[#e0e0e0]">Active follow-ups</div>
                    <div className="truncate text-[10.5px] text-[#777]">{activeFollowUps[0]?.title}</div>
                  </div>
                  <span className="rounded-md bg-[#222] px-1.5 py-0.5 text-[11px] font-semibold text-[#c8c8c8]">
                    {activeFollowUps.length}
                  </span>
                </div>
                {onActiveLifecycle && activeFollowUps[0] ? (
                  <div className="mt-2.5 grid grid-cols-3 gap-1.5 border-t border-[#242424] pt-2.5">
                    {(['pause', 'updateDoc', 'done'] as const).map(action => (
                      <button
                        className={cn(
                          'rounded-md border border-[#2f2f2f] bg-[#1a1a1a] px-1 py-1.5 text-[10px] font-medium text-[#aaa] hover:bg-[#222]',
                          action === 'done' && 'border-[color-mix(in_srgb,#6fc08a_30%,transparent)] text-[#6fc08a]'
                        )}
                        key={action}
                        onClick={() => onActiveLifecycle(action, activeFollowUps[0]!.id)}
                        type="button"
                      >
                        {action === 'updateDoc' ? 'Update doc' : action === 'done' ? 'Done' : 'Pause'}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            'mt-2.5 grid gap-2.5',
            '@lg/today:grid-cols-2',
            (tasksDimmed || meetingsDimmed) && 'opacity-35'
          )}
        >
          <PanelCard
            className={cn(tasksDimmed && 'pointer-events-none')}
            count={`${tasks.length} open`}
            label="Tasks"
          >
            {GROUP_ORDER.map(group => {
              const rows = groupedTasks.get(group)
              if (!rows?.length || (filter && filter !== group && filter !== 'meetings')) {
                return null
              }
              if (filter === 'meetings') {
                return null
              }
              return (
                <div key={group}>
                  <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-[#555]">
                    <span className={cn('size-1.5 rounded-full', GROUP_DOT[group])} />
                    {GROUP_LABEL[group]}
                  </div>
                  {rows.map(task => (
                    <SelectableRow
                      key={task.id}
                      onClick={() => toggleTask(task.id)}
                      selected={referencedIds.has(task.id)}
                    >
                      <div className="text-[12.5px] font-medium text-[#d6d6d6]">{task.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[#777]">
                        <span>{task.meta}</span>
                        {task.tag ? (
                          <span className="rounded border border-[color-mix(in_srgb,#cd9883_35%,transparent)] px-1 text-[9.5px] text-[#cd9883]">
                            {task.tag}
                          </span>
                        ) : null}
                      </div>
                    </SelectableRow>
                  ))}
                </div>
              )
            })}
            {loading && !tasks.length ? (
              <div className="px-3 py-4 text-xs text-(--ui-text-tertiary)">Loading tasks…</div>
            ) : null}
          </PanelCard>

          <PanelCard
            className={cn(meetingsDimmed && 'pointer-events-none')}
            count={`${meetings.length} today`}
            label="Meetings"
          >
            {meetings.map(meeting => (
              <SelectableRow
                key={meeting.id}
                onClick={() => {
                  const full = meetingsById.get(meeting.id)
                  if (full) {
                    onToggleReference(contextRefFromMeeting(full))
                  }
                }}
                selected={referencedIds.has(meeting.id)}
              >
                <div className="grid grid-cols-[42px_1fr] gap-2">
                  <div className="text-[11px] font-semibold tabular-nums text-[#aaa]">{meeting.time}</div>
                  <div>
                    <div className="text-[12.5px] font-medium text-[#d4d4d4]">{meeting.title}</div>
                    <div className="text-[10.5px] text-[#666]">{meeting.sub}</div>
                    {meeting.soon ? (
                      <span className="mt-1 inline-block rounded border border-[color-mix(in_srgb,#6fc08a_35%,transparent)] px-1 text-[9.5px] text-[#6fc08a]">
                        Now
                      </span>
                    ) : null}
                  </div>
                </div>
              </SelectableRow>
            ))}
          </PanelCard>
        </div>

        {needsYou.length ? (
          <PanelCard className="mt-2.5" count={String(needsYou.length)} label="Needs you">
            {needsYou.map(item => (
              <SelectableRow
                key={item.id}
                onClick={() => onToggleReference(contextRefFromNeedsYou(item))}
                selected={referencedIds.has(item.id)}
              >
                <div className="grid grid-cols-[28px_1fr] gap-2">
                  <div
                    className={cn(
                      'grid size-6 place-items-center rounded-md text-xs',
                      item.kind === 'mention' ? 'bg-[#1f2430] text-[#7fa9cf]' : 'bg-[#2a2218] text-[#eab064]'
                    )}
                  >
                    {item.kind === 'mention' ? '@' : '✓'}
                  </div>
                  <div>
                    <div className="text-[12.5px] font-medium text-[#d6d6d6]">{item.title}</div>
                    <div className="text-[10.5px] text-[#777]">{item.meta}</div>
                  </div>
                </div>
              </SelectableRow>
            ))}
          </PanelCard>
        ) : null}

        {docs.length ? (
          <PanelCard className="mt-2.5" label="Wiki & docs">
            {docs.map(item => (
              <SelectableRow
                key={item.id}
                onClick={() => onToggleReference(contextRefFromDoc(item))}
                selected={referencedIds.has(item.id)}
              >
                <div className="grid grid-cols-[28px_1fr] gap-2">
                  <div className="grid size-6 place-items-center rounded-md bg-[#1e1e1e] text-[11px]">📄</div>
                  <div>
                    <div className="text-[12.5px] font-medium text-[#d6d6d6]">{item.title}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10.5px] text-[#777]">
                      {item.tag ? (
                        <span className="rounded border border-[color-mix(in_srgb,#7fa9cf_35%,transparent)] px-1 text-[9.5px] text-[#7fa9cf]">
                          {item.tag}
                        </span>
                      ) : null}
                      <span>{item.meta}</span>
                    </div>
                  </div>
                </div>
              </SelectableRow>
            ))}
          </PanelCard>
        ) : null}
      </div>

      <div className="shrink-0 px-4 pb-4 pt-1">
        <button
          className="group inline-flex h-7 items-stretch overflow-hidden rounded-[6px] bg-[#dba96a] text-[11px] font-medium tracking-[-0.01em] text-[#1a1208] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] transition-[filter,background-color] hover:bg-[#e5b578] active:brightness-[0.97]"
          onClick={onSummarizeDay}
          title="Summarize & plan my day"
          type="button"
        >
          <span className="flex items-center gap-1 px-2.5">
            <span aria-hidden className="text-[10px] leading-none opacity-75">
              ✦
            </span>
            Plan my day
          </span>
          <span className="flex items-center border-l border-[#1a1208]/12 px-1.5 text-[10px] opacity-60 group-hover:opacity-80">
            →
          </span>
        </button>
      </div>
    </section>
  )
}
