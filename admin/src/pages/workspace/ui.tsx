/**
 * Shared primitives for the Workspace mock.
 *
 * Loading choreography lives here too. Every region resolves independently
 * with a skeleton matched to its final geometry, so the page never reflows as
 * content lands — the thing that makes an app feel assembled rather than
 * thrown at the screen.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import {
  AlertTriangle, Boxes, CalendarClock, Check, ChevronRight, FileDown, Globe, Inbox, Library,
  Lock, MoreHorizontal, X,
  type LucideIcon,
} from 'lucide-react'
import {
  ACTION_GROUPS, DATA_SOURCES, SOURCE_LABEL, ceilingAllows, resolveGrants, toolById,
  type ActionGroup, type GrantMap, type Person, type PermissionSource, type Provider,
} from './fixtures'
import { BrandMark } from '@/components/admin/brand-mark'
import { BRAND_CATALOG, type BrandKey } from '@/components/admin/brand-catalog'
import { ApiError } from '@/lib/api'

/* ── Staged loading ───────────────────────────────────
   Regions light up in reading order rather than all at once. The delays are
   deliberately uneven: a real page resolves at the speed of its slowest query,
   and pretending otherwise hides the reflow problems skeletons exist to solve. */
export function useStaged(steps: number[], replayKey: number) {
  const [ready, setReady] = useState<boolean[]>(() => steps.map(() => false))
  useEffect(() => {
    setReady(steps.map(() => false))
    const timers = steps.map((ms, i) =>
      setTimeout(() => setReady((prev) => prev.map((v, j) => (j === i ? true : v))), ms),
    )
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayKey, steps.join(',')])
  return ready
}

/**
 * How a screen reports the outcome of a write.
 *
 * The tone is optional and defaults to success, because most messages are one.
 * It exists because every screen used to report failures through the success
 * channel: "Could not save that key" arrived in green with a checkmark, which
 * is a completed action as far as anyone reading it is concerned.
 */
export type Toast = (message: string, tone?: 'ok' | 'error') => void

export const Skel = ({ w, h = 11, circle, block }: {
  w?: number | string
  h?: number
  circle?: boolean
  /**
   * A rounded rectangle rather than a pill.
   *
   * `line` carries a 999px radius, which reads as a pill at 11px and as an
   * ellipse at two hundred — so a placeholder standing in for a block of
   * content came out as a giant lozenge.
   */
  block?: boolean
}) => (
  <div
    className={`ws-skel${circle ? ' circle' : block ? ' block' : ' line'}`}
    style={{ width: w ?? '100%', height: h, ...(circle ? { borderRadius: '50%' } : {}) }}
  />
)

/** Row skeleton shaped exactly like `.ws-row`, so the swap is invisible. */
export const SkelRows = ({ n = 3, icon = true }: { n?: number; icon?: boolean }) => (
  <div className="ws-rows">
    {Array.from({ length: n }).map((_, i) => (
      <div className="ws-skel-row" key={i}>
        {icon ? <Skel w={32} h={32} /> : null}
        <div style={{ flex: 1 }}>
          <Skel w={`${52 + ((i * 13) % 26)}%`} />
          <div style={{ height: 7 }} />
          <Skel w={`${34 + ((i * 17) % 30)}%`} h={9} />
        </div>
        <Skel w={58} h={22} />
      </div>
    ))}
  </div>
)

export const Fade = ({ children }: { children: ReactNode }) => <div className="ws-in">{children}</div>

/* ── Page furniture ──────────────────────────────────── */
export function PageHeader({
  eyebrow, title, description, actions, badge,
  // `eyebrow` is a node rather than a string so a sub-page can put its way back
  // where the section name would otherwise sit — a wizard's breadcrumb belongs
  // above its own title, not in a rail the wizard has replaced.
}: {
  eyebrow?: ReactNode
  title: string
  description?: string
  actions?: ReactNode
  /*
   * A word about the page itself, set beside its name.
   *
   * Distinct from `actions`, which is where the controls live: a status is not
   * a control, and putting it there had it read as a button nobody could
   * press. Beside the title is where a reader looks to find out what a screen
   * is, so a screen that is not finished says so there.
   */
  badge?: ReactNode
}) {
  return (
    <div className="ws-ph">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <div className="ws-ph-title" style={{ marginTop: eyebrow ? 7 : 0 }}>
          <h1>{title}</h1>
          {badge}
        </div>
        {description ? <p>{description}</p> : null}
      </div>
      {/*
        No third slot for a caveat. Two attempts lived here — beside the buttons,
        where it wrapped, then above them, where it grew the bottom-aligned
        column off the top of the page — and both were a sentence competing with
        the controls it was about. It is a toast now, raised on the press.
      */}
      {actions ? <div className="ws-ph-act">{actions}</div> : null}
    </div>
  )
}

export function Panel({
  title, description, aside, children, footer, source,
}: {
  title?: string
  description?: string
  aside?: ReactNode
  children: ReactNode
  footer?: ReactNode
  source?: keyof typeof DATA_SOURCES
}) {
  return (
    <section className="ws-panel">
      {title ? (
        <header>
          <div className="ws-panel-t">
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          {source ? <DataNote source={source} /> : null}
          {aside}
        </header>
      ) : null}
      {children}
      {footer ? <div className="ws-panel-foot">{footer}</div> : null}
    </section>
  )
}

/** Honest marker: says whether this panel is running on a real endpoint. */
export function DataNote({ source }: { source: keyof typeof DATA_SOURCES }) {
  const d = DATA_SOURCES[source]
  if (d.state === 'live') return null
  const label =
    d.state === 'not-wired' ? 'Sample data'
      : d.state === 'needs-endpoint' ? 'Needs an endpoint'
        : 'Needs backend'
  return (
    <span className="ws-note" data-kind={d.state === 'not-wired' ? 'sample' : 'new'} title={d.note}>
      {label}
    </span>
  )
}

/**
 * A row you can open.
 *
 * Sixteen of these across the workspace were a plain `div` carrying an
 * `onClick` — reachable with a mouse and by nothing else. A keyboard or a
 * screen reader had no way in, and the rows are the primary navigation on the
 * people, department, run and skill lists, so "no way in" meant those screens
 * were a dead end.
 *
 * Not a `<button>`: these hold an avatar, a title, a paragraph and sometimes a
 * nested control, and a button may only contain phrasing content. This is the
 * same shape the skills tree settled on — announce the role, take focus, and
 * answer both Enter and Space the way a real button does.
 */
/**
 * The row's own actions, behind one affordance.
 *
 * Closed on any outside click and on Escape, and it stops propagation on the
 * way out — without that, every menu click also opened the row underneath it.
 *
 * Shared rather than per-screen: it was written for the mail rules list and the
 * team's people list needs exactly the same thing, and a second copy is a
 * second set of listeners to get wrong.
 */
export function RowMenu({ items, busy, label = 'More' }: {
  busy?: boolean
  label?: string
  items: Array<{ label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean }>
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <div className="ws-menu-wrap" ref={wrap} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="icon-btn ws-menu-btn"
        aria-label={label}
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div className="ws-menu" role="menu">
          {items.map((item) => (
            <button
              type="button"
              role="menuitem"
              key={item.label}
              data-danger={item.danger ? 'true' : undefined}
              onClick={() => { setOpen(false); item.onSelect() }}
            >
              <item.icon size={13} /> {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ClickRow({ onOpen, children, ...rest }: {
  onOpen: () => void
  children: ReactNode
  className?: string
  style?: React.CSSProperties
  title?: string
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`ws-row click${rest.className ? ` ${rest.className}` : ''}`}
      style={rest.style}
      title={rest.title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      }}
    >
      {children}
    </div>
  )
}

export const Empty = ({ icon: Icon = Inbox, title, body, action }: {
  icon?: LucideIcon; title: string; body?: string; action?: ReactNode
}) => (
  <div className="ws-empty">
    <div className="ic"><Icon size={17} /></div>
    <b>{title}</b>
    {body ? <p>{body}</p> : null}
    {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
  </div>
)

/**
 * What a refusal looks like.
 *
 * A 403 is an answer, not a failure — somebody asked a question they are not
 * allowed to ask, and the useful reply names who *is* allowed rather than
 * saying "error". Everything that can be refused renders this instead of an
 * empty panel, so a person never has to guess whether Divo is broken or they
 * simply lack the access.
 */
export function NoAccess({ what, who, action }: {
  /** The thing being refused, in the reader's words: "this department". */
  what: string
  /** Who may see it, so the reader knows what to do next. */
  who: string
  action?: ReactNode
}) {
  return (
    <div className="ws-empty">
      <div className="ic"><Lock size={17} /></div>
      <b>You do not have access to {what}</b>
      <p>{who}</p>
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  )
}

/**
 * Turns a failed request into either a refusal or a genuine error.
 *
 * Worth keeping apart: "you may not see this" needs a person to ask someone,
 * "this broke" needs a retry. Collapsing them into one message sends people
 * to the wrong place.
 */
export const isRefusal = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 403 || error.status === 401)

/**
 * A small ask-then-do dialog.
 *
 * Creating a role or a department is one field and a confirm, and routing that
 * through a full drawer made it feel heavier than the decision is. Reuses the
 * modal and scrim primitives already in the stylesheet so it is not a third
 * kind of overlay.
 *
 * The confirm stays disabled until the field has something in it, so the
 * failure mode is "nothing happens" rather than a 400 from the backend.
 */
export function Prompt({ title, description, label, placeholder, confirm, secret, initial, extra, optional, onConfirm, onClose }: {
  title: string
  description?: string
  label: string
  placeholder?: string
  confirm: string
  /**
   * Lets the field be left empty.
   *
   * For the case where the value is a nicety rather than the decision —
   * naming a second Canva account, where the backend has a default and the
   * person is only overriding it. Without this the dialog would insist on a
   * name to do something that does not need one.
   */
  optional?: boolean
  /** Masks the field and stops the browser offering to remember it. */
  secret?: boolean
  /**
   * Seeds the field — for renames, where the current value is what you are
   * editing rather than a hint. Never combine with `secret`.
   */
  initial?: string
  /**
   * Rendered under the field, before the buttons.
   *
   * For the case where one value is not the whole decision — a provider key
   * also has to say which scope it applies to. Kept as a slot rather than
   * growing this into a form builder: two fields is a drawer's job.
   */
  extra?: ReactNode
  onConfirm: (value: string) => Promise<void> | void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if ((!value.trim() && !optional) || busy) return
    setBusy(true)
    try { await onConfirm(value.trim()); onClose() } finally { setBusy(false) }
  }

  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <div className="ws-modal-wrap">
        <div className="ws-modal" role="dialog" aria-label={title}>
          <div className="ws-modal-h">
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <div className="ws-modal-b">
            <div className="ws-lbl">{label}</div>
            <input
              className="input"
              autoFocus
              type={secret ? 'password' : 'text'}
              autoComplete={secret ? 'off' : undefined}
              spellCheck={secret ? false : undefined}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
              style={{ width: '100%', marginTop: 8 }}
            />
            {extra ? <div style={{ marginTop: 18 }}>{extra}</div> : null}
          </div>
          <div className="ws-modal-f">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || (!value.trim() && !optional)}>
              {busy ? 'Working…' : confirm}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Ask before something irreversible, and say what it actually does.
 *
 * The pair to `Prompt`: same overlay, no field. The `body` is where the honesty
 * goes — "sub-folders are archived too" is the sentence that stops a person
 * finding out afterwards.
 */
export function Confirm({ title, body, confirm, onConfirm, onClose }: {
  title: string
  body?: string
  confirm: string
  onConfirm: () => Promise<void> | void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try { await onConfirm(); onClose() } finally { setBusy(false) }
  }

  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <div className="ws-modal-wrap">
        <div className="ws-modal" role="dialog" aria-label={title}>
          <div className="ws-modal-h">
            <h2>{title}</h2>
            {body ? <p>{body}</p> : null}
          </div>
          <div className="ws-modal-f">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Working…' : confirm}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

export const Switch = ({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) => (
  <button type="button" className="ws-switch" data-on={on} aria-label={label} aria-pressed={on} onClick={onToggle}>
    <i />
  </button>
)

export function Seg<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]
}) {
  return (
    <div className="ws-seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A proportion, with one bar in the set allowed to be marked.
 *
 * `tone` was called `brand`, so it was painted in the brand — and every list of
 * bars in the app ended up with a Divo-orange row in it that meant nothing
 * about Divo. What it actually means at all seven call sites is "this is the
 * one worth looking at": the biggest share, the top spender, the budget that is
 * nearly spent. It is called that now, and it draws in the chart ink.
 */
export const Bar = ({ pct, tone }: { pct: number; tone?: 'mark' }) => (
  <div className="ws-bar"><i style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} data-tone={tone} /></div>
)

/**
 * Thirty days of spend, as bars.
 *
 * `data-hot` warms the last week, because recent spend is the part worth
 * noticing. It used to warm the last week *whatever it was worth* — and since
 * an empty bar still draws a 2px sliver, somebody with no activity at all got
 * a row of orange marks under a card reading "$0.00" and "0 tasks". Every
 * pixel of it was false: it said this person has been busy lately, on the one
 * screen an admin opens to find out whether they have.
 *
 * A day with no spend is now never hot. It keeps its sliver, which is the
 * baseline the other bars are read against, in the colour of nothing happening.
 */
export const Spark = ({ data }: { data: number[] }) => {
  const max = Math.max(...data, 1)
  return (
    <div className="ws-spark">
      {data.map((v, i) => (
        <i key={i} style={{ height: `${(v / max) * 100}%` }} data-hot={v > 0 && i >= data.length - 7} />
      ))}
    </div>
  )
}

/**
 * Spend over time, as a line with the area under it filled.
 *
 * The calendar answers "which days" and lives on Home. Repeating it on the team
 * page would be the same widget twice, and the question there is different —
 * a manager wants the shape of the trend, whether spend is climbing or a single
 * week carried the month, which a grid of squares makes you reconstruct square
 * by square.
 *
 * Drawn in real pixels off a `ResizeObserver` rather than a scaled `viewBox`:
 * `preserveAspectRatio="none"` stretches the stroke with the box, so a line
 * that is 1.5px on a narrow card is 4px on a wide one and the grid goes with it.
 */
export function TrendChart({ data, format = money, height = 190 }: {
  data: { date: string; value: number }[]
  format?: (value: number) => string
  height?: number
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  /*
   * Measured on layout first, then watched.
   *
   * Leaving the first width to `ResizeObserver` alone deadlocks whenever the
   * element starts at zero — no width means no `<svg>`, no `<svg>` means no
   * content, and a box with no content never resizes, so the observer has
   * nothing to report and the chart never appears. Reading `clientWidth`
   * synchronously breaks that circle; the observer then only has to handle
   * genuine changes.
   */
  useLayoutEffect(() => {
    if (!box) return
    const measure = () => setWidth(box.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    // A pane that opens at zero width — a hidden tab, a collapsed split — fires
    // no resize on the element itself, so the window is watched too.
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [box])

  const PAD = { top: 10, right: 2, bottom: 22, left: 2 }
  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = Math.max(0, height - PAD.top - PAD.bottom)
  // A flat zero series still gets a baseline rather than dividing by nothing.
  const max = Math.max(...data.map((d) => d.value), 0) || 1

  const xOf = (i: number) => PAD.left + (data.length < 2 ? plotW / 2 : (i / (data.length - 1)) * plotW)
  const yOf = (v: number) => PAD.top + plotH - (v / max) * plotH

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(d.value).toFixed(1)}`).join(' ')
  const area = data.length > 0
    ? `${line} L${xOf(data.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${xOf(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`
    : ''

  const at = hover !== null ? data[hover] : undefined
  const dayText = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  return (
    <div className="ws-trend" ref={setBox}>
      {width > 0 && data.length > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Daily spend, ${dayText(data[0]!.date)} to ${dayText(data[data.length - 1]!.date)}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.left
            const i = Math.round((x / Math.max(plotW, 1)) * (data.length - 1))
            setHover(Math.min(data.length - 1, Math.max(0, i)))
          }}
        >
          <defs>
            <linearGradient id="ws-trend-fill" x1="0" y1="0" x2="0" y2="1">
              {/* `--ws-chart-ink` rather than the brand token: a gradient stop
                  cannot be restyled from a class, so the indirection is the only
                  way a surface can draw this chart in its own colour. */}
              <stop offset="0%" stopColor="var(--ws-chart-ink)" stopOpacity="0.30" />
              <stop offset="100%" stopColor="var(--ws-chart-ink)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Three rules, dashed and quiet. They give the eye a height to read
              against; any more and the grid competes with the line. */}
          {[0, 0.5, 1].map((t) => (
            <line
              key={t}
              x1={PAD.left} x2={PAD.left + plotW}
              y1={PAD.top + plotH * t} y2={PAD.top + plotH * t}
              className="ws-trend-grid"
            />
          ))}

          <path d={area} fill="url(#ws-trend-fill)" />
          <path d={line} className="ws-trend-line" fill="none" />

          {at ? (
            <>
              <line
                x1={xOf(hover!)} x2={xOf(hover!)} y1={PAD.top} y2={PAD.top + plotH}
                className="ws-trend-guide"
              />
              <circle cx={xOf(hover!)} cy={yOf(at.value)} r={3.5} className="ws-trend-dot" />
            </>
          ) : null}
        </svg>
      ) : null}

      <div className="ws-trend-foot">
        {/* The hovered day replaces the range while the pointer is on the plot,
            so the number under the cursor is readable without a floating box
            that would clip at the card's edge. */}
        {at ? (
          <span className="ws-trend-read">{dayText(at.date)} · <b>{format(at.value)}</b></span>
        ) : data.length > 0 ? (
          <>
            <span>{dayText(data[0]!.date)}</span>
            <span>{dayText(data[data.length - 1]!.date)}</span>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Spend per day, as a calendar rather than a bar row.
 *
 * The sparkline drew 30 bars of which three were tall and the rest sat on the
 * floor, which is what light usage actually looks like — so it read as an empty
 * chart rather than as a pattern. A grid gives every quiet day the same square
 * as a busy one, and puts weekdays under each other, so "nothing on weekends"
 * and "one heavy Tuesday" are both visible without a single tall bar.
 *
 * Weeks run down the page and weekdays across, which matches the card's own
 * "last 30 days" framing better than the year-long strip this borrows from.
 */
export const Heatmap = ({ data, format = money }: {
  data: { date: string; value: number }[]
  /** How a cell's value reads on hover. Dollars here, message counts in Mail. */
  format?: (value: number) => string
}) => {
  if (data.length === 0) return null
  const max = Math.max(...data.map((p) => p.value), 0)
  // Parsed at local midnight. Letting the runtime read a bare date as UTC
  // shifts every cell a day west of the timezone the numbers were billed in.
  const dayOf = (iso: string) => new Date(`${iso}T00:00:00`)
  // Monday-first, so the weekend sits together at the foot of a column.
  const weekday = (d: Date) => (d.getDay() + 6) % 7
  const cells: Array<{ key: string; label: string; level: number } | null> = []
  // Pads the first column down to the weekday the window opens on, so every
  // row is one weekday all the way across.
  for (let i = 0; i < weekday(dayOf(data[0]!.date)); i += 1) cells.push(null)
  for (const point of data) {
    const date = dayOf(point.date)
    cells.push({
      key: point.date,
      label: `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${format(point.value)}`,
      // Zero keeps its own step. A quiet day is a fact worth showing, and
      // shading it like a busy one would erase the difference.
      level: point.value <= 0 || max <= 0
        ? 0
        : Math.max(1, Math.ceil((point.value / max) * 4)),
    })
  }

  // The grid has to know its own width to stay inside the card. A fixed cell
  // size overflowed a narrow panel and clipped the last week; a fraction with
  // no ceiling drew tiles when the window was short. Columns are fluid, capped
  // per column, and the count comes from the data rather than a guess.
  const columns = Math.ceil(cells.length / 7)

  return (
    <div className="ws-heat" style={{ ['--ws-cols' as string]: String(columns) }}>
      {/*
        Seven rows, one week per column — the shape every contribution grid
        uses, and the reason it can be wide and short. Filled the other way a
        season is sixteen rows tall and two hundred pixels wide, and a month is
        five columns, which is a shape rather than a pattern.
      */}
      <div className="ws-heat-grid">
        {cells.map((cell, i) => cell === null
          ? <i key={`pad-${i}`} data-pad="true" />
          : <i key={cell.key} data-level={cell.level} title={cell.label} />)}
      </div>
      <div className="ws-heat-key">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => <i key={l} data-level={l} />)}
        <span>More</span>
      </div>
    </div>
  )
}

/**
 * Somebody's initials, in a circle.
 *
 * Initials rather than a photograph because Divo holds no photograph. Nothing
 * in the schema stores an avatar and no route fetches one from Lark, so a
 * component that took a URL would be a slot permanently showing its fallback —
 * and a broken image is a worse answer than a letter.
 *
 * The tint is the accent rather than the brand orange. Orange is scarce here by
 * design and marks the one thing being asked for; an avatar is identity, not an
 * action.
 */
export const Avatar = ({ name, email, src, size = 34 }: {
  name?: string | null
  email?: string | null
  /** Lark's picture, when Divo has been given one. */
  src?: string | null
  size?: number
}) => {
  // Falls back on error as well as on absence. Lark's avatar URLs expire, and a
  // broken image icon where somebody's face should be reads as a fault in Divo
  // rather than as a link that aged out.
  const [broken, setBroken] = useState(false)
  const source = (name ?? '').trim() || (email ?? '').trim()
  // First letter of the first two words, so "Anugra Gupta" reads AG and
  // "anugra.gupta@…" still reads A rather than an empty circle.
  const initials = source
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '—'

  if (src && !broken) {
    return (
      <img
        className="ws-avatar"
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
        // Decorative: the name it belongs to is always beside it, and a second
        // reading of it is noise to a screen reader.
        aria-hidden="true"
        referrerPolicy="no-referrer"
      />
    )
  }

  return (
    <span
      className="ws-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initials}
    </span>
  )
}

/* ── Drawer ──────────────────────────────────────────── */
export function Drawer({ title, subtitle, onClose, children, footer }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <aside className="ws-drawer" role="dialog" aria-label={title}>
        <div className="ws-drawer-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="ws-drawer-b">{children}</div>
        {footer ? <div className="ws-drawer-f">{footer}</div> : null}
      </aside>
    </>
  )
}

/* ── Resizable drawer ─────────────────────────────────
   A drawer holding a tool picker and a system prompt is a workbench, not a
   detail popover, and how wide a workbench should be is the person's call, not
   ours. The width is remembered per drawer, because someone who widened the
   agent editor once meant it. */

export function useDrawerWidth(storageKey: string, initial: number) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved >= 380 ? saved : initial
  })

  const clamp = (px: number) => Math.min(Math.max(px, 380), Math.max(480, window.innerWidth - 160))

  const onGrab = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    document.body.classList.add('ws-resizing')
    // Width is measured from the right edge, because the drawer is anchored
    // there — dragging left makes it wider, which is the direction people
    // expect from a right-hand panel.
    const move = (ev: PointerEvent) => setWidth(clamp(window.innerWidth - ev.clientX))
    const done = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      document.body.classList.remove('ws-resizing')
      setWidth((w) => { try { localStorage.setItem(storageKey, String(w)) } catch { /* quota */ } return w })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
  }, [storageKey])

  const reset = useCallback(() => {
    setWidth(initial)
    try { localStorage.removeItem(storageKey) } catch { /* quota */ }
  }, [initial, storageKey])

  return { width, onGrab, reset }
}

/** The drag edge. Double-click puts it back where it started. */
export const DrawerGrip = ({ onGrab, reset }: { onGrab: (e: React.PointerEvent) => void; reset: () => void }) => (
  <div
    className="ws-drawer-grip"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize panel"
    onPointerDown={onGrab}
    onDoubleClick={reset}
  />
)

/* ── Permission language ──────────────────────────────
   Managers do not think in grants, they think in sentences about people.
   This turns a resolved GrantMap into prose before any matrix is offered. */

const dedupe = (xs: string[]) => Array.from(new Set(xs))
const SENSITIVE = new Set([
  'googleGmail:send', 'googleDrive:delete', 'zohoBooks:update', 'zohoCrm:update',
  'airtableRecords:delete',
])
import { TOOLS } from './fixtures'
const TOOLS_WITH_VERBS = TOOLS.filter((t) => Object.keys(t.verb).length > 0)

/** Human list: "a, b and c". */
export const listPhrase = (items: string[], max = 4) => {
  const shown = items.slice(0, max)
  const rest = items.length - shown.length
  const joined = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? ''
  return rest > 0 ? `${joined}, and ${rest} more` : joined
}

/* ── Permission matrix ────────────────────────────────
   Every cell knows three things: whether it is on, where that came from, and
   whether the company ceiling forbids it. The third is the one that bites —
   a department grant is silently clamped in the backend, so a locked cell
   explains itself rather than just failing later. */

/** A pending permission edit, shown as a diff before it is applied. */
export type PendingChange = { toolId: string; action: ActionGroup; next: boolean; blocked?: boolean }

/* Provider identity is mapped here because Provider is a workspace domain
   type. BrandMark owns every rendering and fallback decision after that. */
const PROVIDER_BRAND: Record<Provider, BrandKey> = {
  google_workspace: 'google',
  lark: 'lark',
  canva: 'canva',
  airtable: 'airtable',
  aitable: 'aitable',
  zoho: 'zoho',
}

/**
 * An app icon, at the size the row asks for.
 *
 * `size` is the **tile**, not the glyph inside it. It used to be the glyph, so
 * the tile stayed 34px from CSS while the thing in it moved — a caller asking
 * for 22 got a 22px logo floating in a 34px box, and every screen had to know
 * that to line anything up.
 *
 * A finished app icon fills the tile edge to edge and is clipped to its corner
 * radius; a glyph on transparency sits inset with room to breathe. That
 * distinction is the whole difference between a list of icons that looks placed
 * and one that looks pasted.
 */
export const ProviderMark = ({ provider, size = 34 }: { provider: Provider; size?: number }) => {
  return <BrandMark brand={PROVIDER_BRAND[provider]} size={size} placement="tile" />
}

/**
 * Which app a tool belongs to, from the name the tool already carries.
 *
 * A permission matrix is fifteen rows of "Google Docs", "Google Sheets", "Lark
 * Task", "Zoho CRM" — read as text it is a wall, and the thing somebody is
 * actually looking for is "the Google ones". The snapshot has no provider
 * field, so this reads the leading word, which is how every tool in the
 * registry is named.
 *
 * Deliberately returns null rather than guessing: an unknown tool gets no mark
 * instead of somebody else's logo, and the row still reads.
 */
const TOOL_PREFIX: Record<string, Provider> = {
  google: 'google_workspace',
  gmail: 'google_workspace',
  lark: 'lark',
  zoho: 'zoho',
  canva: 'canva',
  airtable: 'airtable',
  aitable: 'aitable',
}

export const toolProvider = (toolName: string): Provider | null =>
  TOOL_PREFIX[toolName.trim().split(/[\s_-]/)[0]?.toLowerCase() ?? ''] ?? null

/**
 * Third-party apps that carry real artwork but are not in `Provider`.
 *
 * Shopify is company-owned and reaches the app through its own hook; Semrush is
 * a tool grant with no connection object at all. Both are somebody else's
 * product with a published mark, so both get it.
 */
const TOOL_BRAND: Array<{ match: string; brand: BrandKey }> = [
  { match: 'shopify', brand: 'shopify' },
  { match: 'semrush', brand: 'semrush' },
]

/**
 * Divo's own capabilities, which belong to no third party.
 *
 * These were left blank on the grounds that inventing a logo would imply an
 * integration that does not exist — true, but a blank in a column of marks
 * reads as a row that failed to load rather than as one that has nothing to
 * load. A glyph from Divo's own icon set says what the tool does without
 * borrowing anybody's brand.
 */
const TOOL_GLYPH: Array<{ match: string; icon: LucideIcon }> = [
  { match: 'web search', icon: Globe },
  { match: 'scheduled workflows', icon: CalendarClock },
  { match: 'oms site', icon: Boxes },
  { match: 'secure data export', icon: FileDown },
  { match: 'mail ops', icon: Inbox },
  { match: 'divo knowledge', icon: Library },
]

/** A tool's app mark, at the size a table row can carry. */
export const ToolMark = ({ toolName }: { toolName: string }) => {
  const key = toolName.trim().toLowerCase()
  const provider = toolProvider(toolName)
  if (provider) {
    return <span className="ws-toolmark"><ProviderMark provider={provider} size={24} /></span>
  }

  const branded = TOOL_BRAND.find((candidate) => key.startsWith(candidate.match))
  if (branded) {
    return (
      <span className="ws-toolmark">
        <BrandMark brand={branded.brand} size={24} placement="tile" />
      </span>
    )
  }

  const own = TOOL_GLYPH.find((g) => key.startsWith(g.match))
  if (own) {
    return (
      <span className="ws-toolmark">
        <span className="ws-app ws-app-own" aria-hidden style={{ ['--ws-app' as string]: '24px' }}>
          <own.icon size={14} />
        </span>
      </span>
    )
  }

  // A tool nobody has claimed yet still holds the column, so a name added to the
  // registry tomorrow does not shift every row left until somebody maps it.
  return <span className="ws-toolmark" aria-hidden />
}

export const providerName = (provider: Provider) => BRAND_CATALOG[PROVIDER_BRAND[provider]].label

export const money = (n: number) => `$${n.toFixed(2)}`
export const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
