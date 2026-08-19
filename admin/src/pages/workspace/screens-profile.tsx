/**
 * Who you are, and what Divo has actually done for you.
 *
 * Profile used to be six read-only rows — name, email, role, company — which is
 * a form nobody can fill in. Everything on it was already visible in the account
 * menu, so the page existed to be correct rather than to be opened.
 *
 * The facts worth a page were sitting in a table nothing read: every run Divo
 * has made on your behalf, every token it put through, priced per model. A year
 * of those days says things a settings row cannot — that you have asked Divo for
 * something on twenty-nine consecutive days, that one Tuesday in July moved
 * thirty-eight million tokens, that the longest thing it ever finished for you
 * took just under an hour.
 *
 * Nothing here is a channel's view. The counts span Lark, the desktop and this
 * app together, because they are about a person rather than about a surface —
 * which is also why the identity rows stayed on the page rather than moving
 * aside for the charts.
 *
 * One request covers all of it, and one window: a year. There was briefly a
 * 16-weeks / 26-weeks / Year control, and it earned its space on none of the
 * three cards — the calendar is a year-shaped object, the tasks chart already
 * has a month switcher of its own, and the tiles beside it are lifetime figures
 * that ignored the setting entirely. A control that restates part of the page
 * is a thing to read before you can read the page. Every figure below is a fold
 * over the same array of days, so nothing here can disagree with anything else.
 */
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import {
  byMonth, dayLabel, dayTokens, longestStreak, peakDay, spanLabel, useMyUsage,
  type UsageMonth, type UsagePoint,
} from './data/use-my-activity'
import { Avatar, Heatmap, Skel, TrendChart, compact, money } from './ui'
import { COMPANY_ROLE_LABEL, SettingsGroup, SettingsRow, SettingsSection } from './screens-settings'

/** The longest window the endpoint will answer for, and the one this asks for. */
const YEAR = 365

/* ── Reading the series ───────────────────────────────── */

const sum = (days: UsagePoint[], of: (point: UsagePoint) => number): number =>
  days.reduce((total, point) => total + of(point), 0)

/**
 * A cover nobody uploaded, but that is still this person's own.
 *
 * Confined to the cool half of the wheel — cyan through blue and violet to
 * magenta. A hash across all 360° is how you get somebody a bilious yellow-green
 * banner, and "it was random" is no comfort to the person whose profile it is.
 * This band also sits with the accent the charts below are drawn in, so the card
 * reads as one thing rather than two colour schemes stacked.
 */
const COVER_HUE_FROM = 196
const COVER_HUE_SPAN = 148

const coverHue = (seed: string): number => {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 4096
  return COVER_HUE_FROM + (hash % COVER_HUE_SPAN)
}

/* ── Pieces ───────────────────────────────────────────── */

/** A figure and what it is. Two lines, so a wrapped label cannot shift a row. */
const Tile = ({ value, label, title }: { value: string; label: string; title?: string }) => (
  <div className="prof-tile" title={title}>
    <b>{value}</b>
    <span>{label}</span>
  </div>
)

/**
 * One bar per day of a month.
 *
 * A day with nothing keeps a visible stub rather than disappearing, so a gap in
 * the middle of a month reads as a quiet Tuesday and not as a chart that stops
 * short. The stub is drawn in the colour of nothing happening, which is the
 * distinction `Spark` had to learn the hard way.
 */
function DayBars({ days, of, format }: {
  days: UsagePoint[]
  of: (point: UsagePoint) => number
  format: (value: number) => string
}) {
  const max = Math.max(...days.map(of), 1)
  return (
    <div className="prof-bars">
      {days.map((point) => {
        const value = of(point)
        return (
          <i
            key={point.date}
            style={{ height: `${(value / max) * 100}%` }}
            data-empty={value === 0 ? 'true' : undefined}
            title={`${dayLabel(point.date)} · ${format(value)}`}
          />
        )
      })}
    </div>
  )
}

/** ‹ August 2026 ›, stopping at the ends of the year rather than wrapping. */
function MonthSwitcher({ months, index, onChange }: {
  months: UsageMonth[]
  index: number
  onChange: (index: number) => void
}) {
  return (
    <div className="prof-switch">
      <button
        type="button"
        onClick={() => onChange(index - 1)}
        disabled={index <= 0}
        aria-label="Previous month"
      >
        <ChevronLeft size={15} />
      </button>
      <b>{months[index]?.label ?? '—'}</b>
      <button
        type="button"
        onClick={() => onChange(index + 1)}
        disabled={index >= months.length - 1}
        aria-label="Next month"
      >
        <ChevronRight size={15} />
      </button>
    </div>
  )
}

/* ── The page ─────────────────────────────────────────── */

export function SettingsProfile() {
  const { session } = useAdminAuth()
  // One year, one request — see the note at the top of the file.
  const { usage, loading } = useMyUsage(YEAR)
  /* Null until somebody moves it, so the card follows the newest month as the
     data changes rather than pinning to whichever index happened to be current
     when it first rendered. */
  const [month, setMonth] = useState<number | null>(null)

  const months = useMemo(() => byMonth(usage.series), [usage.series])
  const monthIndex = Math.min(month ?? months.length - 1, months.length - 1)
  const shown = months[monthIndex]

  const tasks = sum(usage.series, (p) => p.runs)
  const tokens = sum(usage.series, dayTokens)
  const spend = sum(usage.series, (p) => p.spendUsd)
  const peak = peakDay(usage.series)
  const streak = longestStreak(usage.series)

  const name = session?.name ?? session?.email ?? 'Your profile'
  const handle = session?.email?.split('@')[0] ?? null
  const role = COMPANY_ROLE_LABEL[session?.role ?? ''] ?? session?.role ?? null

  return (
    <div className="prof">
      {/* ── Who ───────────────────────────────────────── */}
      <div className="prof-card">
        {/*
          A cover Divo generates rather than one somebody uploads. There is no
          route that stores an image and no column to put it in, so an upload
          button would be a control that goes nowhere — and a flat band of grey
          reads as a picture that failed to load. Derived from the user id, so
          it is stable, and it is theirs.
        */}
        <div className="prof-cover" style={{ ['--prof-hue' as string]: String(coverHue(session?.userId ?? name)) }} />

        <div className="prof-id">
          <div className="prof-face">
            <Avatar name={session?.name} email={session?.email} src={session?.avatarUrl} size={72} />
          </div>
          <h1>{name}</h1>
          <div className="prof-sub">
            {handle ? <span>@{handle}</span> : null}
            {role ? <span className="prof-tag">{role}</span> : null}
            {session?.companyName ? <span>{session.companyName}</span> : null}
          </div>
        </div>

        <div className="prof-head">
          <div className="ws-lbl">Tasks in the last year</div>
          <div className="prof-hero">
            {/*
              No change badge, and that is the honest answer rather than a
              missing feature. The endpoint holds one year; a "+41%" beside a
              year's total would have to be measured against a year nobody
              fetched. It comes back the day this asks for two.
            */}
            {loading ? <Skel w={130} h={34} /> : <b>{tasks.toLocaleString()}</b>}
          </div>
          {/*
            Cost is on the page but not the headline. It is real money the
            company pays, and a big number with a rising arrow beside it invites
            somebody to read their own spend as a score.
          */}
          <div className="ws-sub prof-cost">
            {loading ? null : `${money(spend)} · ${compact(tokens)} tokens · ${usage.cacheSavingsPct}% served from cache`}
          </div>
        </div>

        <div className="prof-tiles">
          <Tile
            value={loading ? '—' : compact(usage.lifetimeTokens)}
            label="Lifetime tokens"
            title="Everything ever, whatever range is selected"
          />
          <Tile
            value={loading || !peak || dayTokens(peak) === 0 ? '—' : compact(dayTokens(peak))}
            label="Busiest day"
            title={peak && dayTokens(peak) > 0 ? dayLabel(peak.date) : undefined}
          />
          <Tile
            value={loading ? '—' : spanLabel(usage.longestRunMs)}
            label="Longest task"
            title="The longest run Divo has ever finished for you"
          />
          <Tile
            value={loading ? '—' : streak === 0 ? '—' : `${streak} day${streak === 1 ? '' : 's'}`}
            label="Longest streak"
            title="Consecutive days you asked Divo for something"
          />
        </div>

        <div className="prof-activity">
          <div className="prof-bar">
            <div className="ws-lbl">Activity</div>
          </div>
          {loading ? <Skel w="100%" h={120} block /> : (
            /*
              Shaded by tasks, not by spend. A day whose only task was refused,
              or that failed before its first model call, records no tokens at
              all — and colouring by money would tell that person they did not
              use Divo on a day they did.
            */
            <Heatmap
              data={usage.series.map((point) => ({ date: point.date, value: point.runs }))}
              format={(value) => (value === 1 ? '1 task' : `${value} tasks`)}
            />
          )}
        </div>
      </div>

      {/* ── Tasks, month by month ─────────────────────── */}
      <div className="prof-card prof-chart">
        <div className="prof-bar">
          <div>
            <div className="ws-lbl">Tasks</div>
            <div className="prof-figure">
              {shown ? `${sum(shown.days, (p) => p.runs).toLocaleString()} tasks` : '—'}
            </div>
          </div>
          {months.length > 1
            ? <MonthSwitcher months={months} index={monthIndex} onChange={setMonth} />
            : null}
        </div>
        {loading ? <Skel w="100%" h={150} block /> : shown ? (
          <>
            <DayBars
              days={shown.days}
              of={(point) => point.runs}
              format={(value) => (value === 1 ? '1 task' : `${value} tasks`)}
            />
            <div className="prof-axis">
              <span>{dayLabel(shown.days[0]!.date)}</span>
              <span>{dayLabel(shown.days[shown.days.length - 1]!.date)}</span>
            </div>
          </>
        ) : <div className="ws-sub">Nothing recorded yet.</div>}
      </div>

      {/* ── Tokens across the year ────────────────────── */}
      <div className="prof-card prof-chart">
        <div className="prof-bar">
          <div>
            <div className="ws-lbl">Tokens</div>
            <div className="prof-figure">{compact(tokens)} tokens</div>
          </div>
        </div>
        {loading ? <Skel w="100%" h={170} block /> : (
          <TrendChart
            data={usage.series.map((point) => ({ date: point.date, value: dayTokens(point) }))}
            format={compact}
            height={170}
          />
        )}
      </div>

      {/* ── Who Divo thinks you are ───────────────────── */}
      <SettingsSection title="Account" />
      <SettingsGroup>
        <SettingsRow label="Full name" description="From your company directory, which is why it is not editable here">
          <span className="set-val">{session?.name ?? '—'}</span>
        </SettingsRow>
        <SettingsRow label="Email" description="Where Divo reaches you, and how you sign in">
          <span className="set-val">{session?.email ?? '—'}</span>
        </SettingsRow>
        <SettingsRow label="Company">
          <span className="set-val">{session?.companyName ?? '—'}</span>
        </SettingsRow>
        <SettingsRow
          label="Lark"
          description={session?.larkLinked
            ? 'Linked — messages you send Divo in Lark resolve to this account'
            : 'Not linked. Until you link it once, your Lark messages cannot be matched to this account.'}
        >
          <span className={`badge ${session?.larkLinked ? 'b-ok' : 'b-warn'}`}>
            <span className="dot" />{session?.larkLinked ? 'Linked' : 'Not linked'}
          </span>
        </SettingsRow>
      </SettingsGroup>

      {/*
        Departments as rows rather than as one comma-joined string. They were
        rendered as "Tech Testing · Manager, Finance · Manager" in a right-aligned
        cell — which is the sentence that decides what Divo may do for you,
        printed as a list nobody can scan.
      */}
      <SettingsSection title="What Divo may do for you" />
      <SettingsGroup>
        <SettingsRow
          label="Company role"
          description="Your ceiling. On its own it grants nothing — every capability comes from a department."
        >
          <span className="set-val">{role ?? '—'}</span>
        </SettingsRow>
        {(session?.departments ?? []).map((department) => (
          <SettingsRow
            key={department.id}
            label={department.name}
            description={department.isManager
              ? 'You manage this department, so you can also grant what it may use.'
              : 'Your role here decides which tools Divo may use on your behalf.'}
          >
            <span className="set-val">{department.roleName}</span>
          </SettingsRow>
        ))}
        {(session?.departments.length ?? 0) === 0 ? (
          <SettingsRow
            label="No department yet"
            description="Until somebody adds you to one, Divo can answer you but cannot act for you."
          />
        ) : null}
      </SettingsGroup>

      <div className="set-note">
        <CircleAlert size={13} />
        One account across the web, Lark and the desktop — everything above counts all three together.
      </div>
    </div>
  )
}
