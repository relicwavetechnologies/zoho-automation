/**
 * Two lists, because there are two rules with two different scopes.
 *
 * The first version drew both on one row: an "Ask me" pill and a "Team" pill,
 * side by side, inside a department tab. That put a personal, global setting
 * inside a per-team container, and the container won. Somebody ticking "Ask me"
 * under Tech Testing could not tell whether they had covered one team or all of
 * them, whether a tool in two teams needed ticking twice, or whether the pick
 * survived asking from Finance. The answers are all-of-them, once, and yes —
 * and nothing on screen said so, because the tab above was saying otherwise.
 *
 * So one control per list, and the list's own header declares the scope:
 *
 *   PersonalForecast — yours, every team, no department anywhere near it.
 *   TeamForecast     — one department, about everybody except its approver.
 *
 * The badge on every row is `forecastGate` in both lists, so the two never tell
 * different stories about what will actually happen. The list decides what you
 * can change; the badge decides what is true.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { BrandMark } from '@/components/admin/brand-mark'
import { Skel } from './../ui'
import type { BrandKey } from '@/components/admin/brand-catalog'
import {
  bandFor,
  forecastGate,
  outcomeLabel,
  outcomeReason,
  outcomeTone,
  type GateOutcome,
  type GatePolicy,
} from './forecast'
import { personallyPicked, type PersonalGate } from './personal-gate'

export type ForecastRow = {
  toolId: string
  /** "Lark Calendar". */
  toolName: string
  action: string
  /** "Delete events". */
  actionLabel: string
  brand?: BrandKey
}

/** What a row lets you change, if anything. One per list, never two. */
type Control = {
  label: string
  on: boolean
  title: string
  onClick?: () => void
  /** Why it cannot be clicked now. Present means it cannot. */
  locked?: string
}

type Entry = { row: ForecastRow; outcome: GateOutcome }

type Shared = {
  rows: ForecastRow[]
  /** Still reading. Distinct from "read it, and there is nothing". */
  loading?: boolean
  /** What the reader typed in the filter box, if anything. */
  query?: string
  policy: GatePolicy | null
  channel: 'web' | 'lark' | 'desktop'
  askerIsApprover: boolean
  selfBypassDisabled: boolean
  approverExists: boolean
  personal: PersonalGate
  approverName?: string
}

function outcomes(input: Shared): Entry[] {
  const needle = (input.query ?? '').trim().toLowerCase()
  return input.rows
    .filter((row) => !needle || matches(row, needle))
    .map((row) => ({
      row,
      outcome: forecastGate({
        toolId: row.toolId,
        action: row.action,
        policy: input.policy,
        channel: input.channel,
        askerIsApprover: input.askerIsApprover,
        selfBypassDisabled: input.selfBypassDisabled,
        approverExists: input.approverExists,
        personal: input.personal,
      }),
    }))
}

/**
 * "What will Divo check with me about?"
 *
 * No department appears anywhere in here, which is the whole point. One row per
 * action, once, whatever teams the reader belongs to.
 */
export function PersonalForecast({
  onToggle, ...shared
}: Shared & { onToggle: (toolId: string, action: string) => void }) {
  const entries = outcomes(shared)
  const { personal } = shared

  /* Picked, not merely stopping. A member's team gate also stops them, but it
     stops them by asking somebody else, and it is not on their list. */
  const yours = entries.filter((e) => e.outcome.kind === 'you_confirm' && e.outcome.because === 'you_picked')
  const exposed = entries.filter((e) => bandFor(e.outcome, e.row.action) === 'exposed')
  const rest = entries.filter((e) => !yours.includes(e) && !exposed.includes(e))

  const control = (row: ForecastRow): Control => ({
    label: 'Ask me',
    on: personallyPicked(personal, row.toolId, row.action) || personal.all,
    title: `Have Divo check with you before it does “${row.actionLabel}”, in every team`,
    /* While "everything" is on, a per-action pill cannot change anything, so it
       does not pretend to. */
    ...(personal.all
      ? { locked: 'Turn off “ask me about everything” to choose actions one at a time.' }
      : { onClick: () => onToggle(row.toolId, row.action) }),
  })

  if (shared.loading && entries.length === 0) return <Shell><ForecastSkeleton /></Shell>
  if (entries.length === 0) return <Shell><Empty query={shared.query} /></Shell>

  return (
    <Shell>
      <Band
        title={yours.length === 1 ? '1 action asks you' : `${yours.length} actions ask you`}
        note="Divo shows you what it is about to do and waits for your yes."
        tone="stop"
        entries={yours}
        empty="Nothing asks you yet. Tick “Ask me” on anything below."
        control={control}
        showReason={false}
      />

      {/* Open and above the fold, because this is the one thing the page has to
          volunteer. Somebody picked create and update on their calendar, read
          the page as covering their calendar, and lost an event to the delete
          row sitting alphabetised in the fold below. */}
      {exposed.length > 0 ? (
        <Band
          title={exposed.length === 1
            ? '1 action runs unasked and cannot be undone'
            : `${exposed.length} actions run unasked and cannot be undone`}
          note="Nothing stops these and nothing brings them back."
          tone="stop"
          entries={exposed}
          scroll
          control={control}
          showReason={false}
        />
      ) : null}

      <Band
        title={shared.loading ? 'Runs straight away' : `Runs straight away (${rest.length})`}
        note={shared.loading
          ? 'Still counting.'
          : 'Divo does these without checking with you. Tick any to change that.'}
        tone="go"
        entries={rest}
        collapsible
        groupByTool
        forceOpen={(shared.query ?? '').trim().length > 0}
        control={control}
        showReason={false}
      />
    </Shell>
  )
}

/**
 * "What does this team need approval for?"
 *
 * One department, and about everybody in it except whoever approves. The pill
 * is absent for anybody who may not change the policy, which is most people.
 */
export function TeamForecast({
  onToggle, ...shared
}: Shared & { onToggle?: (toolId: string, action: string) => void }) {
  const entries = outcomes(shared)

  const gated = entries.filter((e) => {
    const band = bandFor(e.outcome, e.row.action)
    return band === 'watched' || e.outcome.kind === 'approver_says_yes' || e.outcome.kind === 'blocked'
  })
  const rest = entries.filter((e) => !gated.includes(e))

  const control = onToggle
    ? (row: ForecastRow): Control => ({
      label: 'Team',
      on: gated.some((e) => e.row.toolId === row.toolId && e.row.action === row.action),
      title: `Require the manager's approval for “${row.actionLabel}”, for everybody in this team`,
      onClick: () => onToggle(row.toolId, row.action),
    })
    : undefined

  if (shared.loading && entries.length === 0) return <Shell><ForecastSkeleton /></Shell>
  if (entries.length === 0) return <Shell><Empty query={shared.query} /></Shell>

  return (
    <Shell>
      <Band
        title={gated.length === 1
          ? '1 action asks your manager'
          : `${gated.length} actions ask your manager`}
        note={shared.askerIsApprover
          ? 'You are the manager here, so you are the one asked. They never stop you.'
          : 'Divo waits for your manager before it does these.'}
        tone="stop"
        entries={gated}
        empty="This team gates nothing. Everything runs without asking anybody."
        {...(control ? { control } : {})}
        {...(shared.approverName ? { approverName: shared.approverName } : {})}
        showReason
      />

      <Band
        title={shared.loading ? 'Runs straight away' : `Runs straight away (${rest.length})`}
        note={shared.loading ? 'Still counting.' : 'Nobody is asked before Divo does these.'}
        tone="go"
        entries={rest}
        collapsible
        groupByTool
        forceOpen={(shared.query ?? '').trim().length > 0}
        {...(control ? { control } : {})}
        showReason={false}
      />
    </Shell>
  )
}

function matches(row: ForecastRow, needle: string): boolean {
  return `${row.toolName} ${row.actionLabel} ${row.toolId} ${row.action}`
    .toLowerCase()
    .includes(needle)
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="ws-stack">{children}</div>
}

function Empty({ query }: { query?: string }) {
  const needle = (query ?? '').trim()
  return (
    <div className="rounded-card bg-surface px-4 py-3 shadow-card">
      <p className="text-[13px] font-medium leading-tight text-ink">
        {needle ? `Nothing matches “${needle}”` : 'No actions to show yet'}
      </p>
      <p className="mt-1 text-[11.5px] leading-snug text-ink-3">
        {needle
          ? 'Try the tool name, or the thing you want to do with it.'
          : 'Divo could not list the actions available to you, so this says nothing about what is gated.'}
      </p>
    </div>
  )
}

function Band({
  title, note, tone, entries, empty, collapsible, groupByTool, forceOpen, scroll, approverName,
  showReason, control,
}: {
  title: string
  note: string
  tone: 'stop' | 'go'
  entries: Entry[]
  /** Shown instead of rows when empty. Absent means hide the band entirely. */
  empty?: string
  collapsible?: boolean
  groupByTool?: boolean
  forceOpen?: boolean
  /** Cap the height and scroll inside, for a band that must stay open however long it is. */
  scroll?: boolean
  approverName?: string
  showReason: boolean
  control?: (row: ForecastRow) => Control
}) {
  /* The band that answers the question is open. The bands that answer "and what
     about everything else" are shut until asked, which is the whole point. */
  const [open, setOpen] = useState(!collapsible)
  const shown = collapsible ? open || Boolean(forceOpen) : true

  if (entries.length === 0 && !empty) return null

  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-card">
      <button
        type="button"
        disabled={!collapsible}
        aria-expanded={shown}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-start gap-2 px-4 py-3 text-left disabled:cursor-default"
      >
        {collapsible ? (
          <ChevronRight
            size={14}
            aria-hidden
            className="mt-[3px] shrink-0 text-ink-3 transition-transform duration-150"
            style={shown ? { transform: 'rotate(90deg)' } : undefined}
          />
        ) : (
          <span
            aria-hidden
            className="mt-[7px] size-1.5 shrink-0 rounded-full"
            style={{ background: tone === 'stop' ? 'var(--bui-accent)' : 'var(--bui-ink-3)' }}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium leading-tight text-ink">{title}</span>
          <span className="mt-1 block text-[11.5px] leading-snug text-ink-3">{note}</span>
        </span>
      </button>

      {shown ? (
        entries.length === 0 ? (
          <p className="border-t border-line px-4 py-3 text-[11.5px] leading-snug text-ink-3">{empty}</p>
        ) : groupByTool ? (
          <ToolGroups entries={entries} forceOpen={forceOpen} {...(control ? { control } : {})} />
        ) : (
          <div
            className="divide-y divide-line border-t border-line"
            style={scroll ? { maxHeight: 320, overflowY: 'auto' } : undefined}
          >
            {entries.map((entry) => (
              <Row
                key={`${entry.row.toolId}:${entry.row.action}`}
                entry={entry}
                showTool
                showReason={showReason}
                {...(approverName ? { approverName } : {})}
                {...(control ? { control } : {})}
              />
            ))}
          </div>
        )
      ) : null}
    </section>
  )
}

/**
 * One line per tool, expanded on demand.
 *
 * This is the fold that makes a long list readable. A hundred rows of "runs
 * without asking" carry almost no information each; a dozen tool names carry
 * the same information and fit on a screen.
 */
function ToolGroups({
  entries, forceOpen, control,
}: {
  entries: Entry[]
  forceOpen?: boolean
  control?: (row: ForecastRow) => Control
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())

  const byTool = new Map<string, Entry[]>()
  for (const entry of entries) {
    const existing = byTool.get(entry.row.toolId)
    if (existing) existing.push(entry)
    else byTool.set(entry.row.toolId, [entry])
  }
  const tools = [...byTool.entries()].sort(
    ([, a], [, b]) => (a[0]?.row.toolName ?? '').localeCompare(b[0]?.row.toolName ?? ''),
  )

  return (
    <div className="divide-y divide-line border-t border-line">
      {tools.map(([toolId, rows]) => {
        const first = rows[0]!
        const shown = forceOpen || open.has(toolId)
        return (
          <div key={toolId}>
            <button
              type="button"
              aria-expanded={shown}
              onClick={() => setOpen((was) => {
                const next = new Set(was)
                if (next.has(toolId)) next.delete(toolId)
                else next.add(toolId)
                return next
              })}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-fill"
            >
              <ChevronRight
                size={14}
                aria-hidden
                className="shrink-0 text-ink-3 transition-transform duration-150"
                style={shown ? { transform: 'rotate(90deg)' } : undefined}
              />
              {first.row.brand ? (
                <BrandMark brand={first.row.brand} size={16} />
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                {first.row.toolName}
              </span>
              <span className="shrink-0 text-[11px] text-ink-3">
                {rows.length === 1 ? '1 action' : `${rows.length} actions`}
              </span>
            </button>

            {shown ? (
              <div className="divide-y divide-line border-t border-line bg-page/40">
                {rows.map((entry) => (
                  <Row
                    key={`${entry.row.toolId}:${entry.row.action}`}
                    entry={entry}
                    showTool={false}
                    showReason={false}
                    indent
                    {...(control ? { control } : {})}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function Row({
  entry, showTool, showReason, indent, approverName, control,
}: {
  entry: Entry
  showTool: boolean
  showReason: boolean
  indent?: boolean
  approverName?: string
  control?: (row: ForecastRow) => Control
}) {
  const { row, outcome } = entry
  const tone = outcomeTone(outcome)
  const pill = control?.(row)

  return (
    /* Wraps rather than squeezes. The badge and the pill have a floor width, so
       in a narrow column an unwrapped row ate the action name instead. */
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 pr-4 ${indent ? 'pl-[54px]' : 'pl-4'}`}>
      {showTool ? (
        row.brand ? <BrandMark brand={row.brand} size={16} />
          : <span className="size-4 shrink-0" aria-hidden />
      ) : null}

      <div className="min-w-[150px] flex-1">
        <p className="truncate text-[12.5px] leading-tight text-ink">
          {row.actionLabel}
          {showTool ? <span className="text-ink-3"> · {row.toolName}</span> : null}
        </p>
        {showReason ? (
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-2">
            {outcomeReason(outcome, approverName)}
          </p>
        ) : null}
      </div>

      <span
        className="ml-auto shrink-0 rounded-chip px-1.5 py-0.5 text-[10.5px] font-medium leading-tight"
        style={
          tone === 'fault'
            ? { background: 'var(--bui-red-tint)', color: 'var(--bui-red-ink)' }
            : tone === 'stop'
              ? { background: 'var(--bui-accent-tint)', color: 'var(--bui-accent-ink)' }
              : { background: 'var(--bui-fill)', color: 'var(--bui-ink-3)' }
        }
      >
        {outcomeLabel(outcome)}
      </span>

      {pill ? <Pill {...pill} /> : null}
    </div>
  )
}

/** A labelled on/off, small enough to sit on a dense row. */
function Pill({ label, title, on, onClick, locked }: Control) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      title={locked ?? title}
      disabled={Boolean(locked)}
      onClick={onClick}
      className="shrink-0 rounded-chip px-2 py-1 text-[11px] font-medium leading-none transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
      style={on
        ? { background: 'var(--bui-ink)', color: 'var(--bui-surface)' }
        : { background: 'var(--bui-fill)', color: 'var(--bui-ink-3)' }}
    >
      {label}
    </button>
  )
}

/**
 * The bands before anything is known about them.
 *
 * Shape-matched to what lands, so the card does not jump when it does. The
 * first band draws rows because it is the one that opens; the others draw their
 * headers only, because they arrive collapsed.
 */
function ForecastSkeleton() {
  return (
    <>
      {[0, 1].map((band) => (
        <div key={band} className="overflow-hidden rounded-card bg-surface shadow-card" aria-busy="true">
          <div className="flex items-start gap-2 px-4 py-3">
            <Skel w={12} h={12} circle />
            <div className="min-w-0 flex-1">
              <Skel w={band === 0 ? 168 : 144} h={12} />
              <div style={{ height: 7 }} />
              <Skel w={`${60 + band * 8}%`} h={9} />
            </div>
          </div>
          {band === 0 ? (
            <div className="divide-y divide-line border-t border-line">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-3 px-4 py-2.5">
                  <Skel w={16} h={16} block />
                  <div className="min-w-0 flex-1">
                    <Skel w={`${38 + ((row * 17) % 26)}%`} h={11} />
                  </div>
                  <Skel w={88} h={16} block />
                  <Skel w={52} h={20} block />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}
