/**
 * Shared primitives for the Workspace mock.
 *
 * Loading choreography lives here too. Every region resolves independently
 * with a skeleton matched to its final geometry, so the page never reflows as
 * content lands — the thing that makes an app feel assembled rather than
 * thrown at the screen.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle, Check, ChevronRight, Inbox, Lock, X,
  type LucideIcon,
} from 'lucide-react'
import {
  ACTION_GROUPS, DATA_SOURCES, SOURCE_LABEL, ceilingAllows, resolveGrants, toolById,
  type ActionGroup, type GrantMap, type Person, type PermissionSource, type Provider,
} from './fixtures'
import { GoogleMark } from './brand'
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
  eyebrow, title, description, actions,
  // `eyebrow` is a node rather than a string so a sub-page can put its way back
  // where the section name would otherwise sit — a wizard's breadcrumb belongs
  // above its own title, not in a rail the wizard has replaced.
}: {
  eyebrow?: ReactNode
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="ws-ph">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 style={{ marginTop: eyebrow ? 7 : 0 }}>{title}</h1>
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

export const Bar = ({ pct, tone }: { pct: number; tone?: 'brand' }) => (
  <div className="ws-bar"><i style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} data-tone={tone} /></div>
)

export const Spark = ({ data }: { data: number[] }) => {
  const max = Math.max(...data, 1)
  return (
    <div className="ws-spark">
      {data.map((v, i) => (
        <i key={i} style={{ height: `${(v / max) * 100}%` }} data-hot={i >= data.length - 7} />
      ))}
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

/* ── Permission language ──────────────────────────────
   Managers do not think in grants, they think in sentences about people.
   This turns a resolved GrantMap into prose before any matrix is offered. */

const dedupe = (xs: string[]) => Array.from(new Set(xs))
const SENSITIVE = new Set([
  'googleGmail:send', 'googleDrive:delete', 'zohoBooks:update', 'zohoCrm:update',
  'airtableRecords:delete', 'dataExport:create',
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

/* ── Provider glyphs ─────────────────────────────────
   Real marks where Divo has the real file, and a branded tile where it does
   not. These were six identical grey squares carrying a letter, which read as
   placeholders for logos rather than as a choice — an app list is scanned by
   shape and colour, and initials give it neither.

   `brand.tsx` sets the rule this follows: a mark is drawn only where the real
   artwork is known exactly. Google publishes a fixed path and Lark's own PNG is
   in `public/brand`. The rest get their brand colour rather than an invented
   logo, because a mark redrawn from memory is recognisable enough to be trusted
   and wrong enough to be somebody else's product. Drop `<provider>.png` into
   `public/brand` and add it to `asset` below to promote one. */
const PROVIDER_META: Record<Provider, {
  short: string
  name: string
  /**
   * The brand's colour as the tile's *fill*, with `ink` on top.
   *
   * Tinting the letter instead — brand colour as text on the card's own surface
   * — measured 1.54:1 for Airtable's amber and 1.84:1 for Canva's teal in light
   * mode. A brand colour is chosen to be seen against its own tile, not to be
   * read as type on white, so the tile takes the colour and the letter takes a
   * foreground picked to clear 4.5:1 against it.
   */
  tint?: string
  ink?: string
  /** A drawn mark, where the real artwork is known exactly. */
  mark?: (size: number) => JSX.Element
  /** A real file under `public/brand`. */
  asset?: string
}> = {
  google_workspace: { short: 'G', name: 'Google Workspace', mark: (s) => <GoogleMark size={s} /> },
  lark: { short: 'L', name: 'Lark', asset: '/brand/lark.png' },
  // Dark ink rather than white, like Airtable's amber. White on Canva's teal is
  // 3.01:1 however the teal is nudged, and darkening it far enough to carry
  // white stops looking like Canva.
  canva: { short: 'C', name: 'Canva', tint: '#00C4CC', ink: '#00312F' },
  airtable: { short: 'A', name: 'Airtable', tint: '#FCB400', ink: '#3A2600' },
  aitable: { short: 'Ai', name: 'AITable', tint: '#5B44CC', ink: '#FFFFFF' },
  zoho: { short: 'Z', name: 'Zoho', tint: '#D32124', ink: '#FFFFFF' },
}

/**
 * An app icon, at the size the row asks for.
 *
 * A tile rather than a bare glyph, so a drawn logo, a PNG and a lettered
 * fallback all occupy the same square and a list of them lines up whatever mix
 * it happens to contain.
 */
export const ProviderMark = ({ provider, size = 20 }: { provider: Provider; size?: number }) => {
  const meta = PROVIDER_META[provider]
  return (
    <span className="ws-app" aria-hidden data-plain={meta.mark || meta.asset ? 'true' : undefined}>
      {meta.mark
        ? meta.mark(size)
        : meta.asset
          ? <img src={meta.asset} width={size} height={size} alt="" loading="lazy" decoding="async"
              style={{ width: size, height: size, display: 'block' }} />
          : (
            /* The letter kept its grey box before, so Canva and Zoho were the
               same object. A filled tile in the brand's colour reads as that
               app at a glance without claiming to be its logo. */
            <span
              className="ws-app-l"
              style={{ color: meta.ink, background: meta.tint, fontSize: Math.round(size * 0.52) }}
            >
              {meta.short}
            </span>
          )}
    </span>
  )
}

export const providerName = (p: Provider) => PROVIDER_META[p].name

export const money = (n: number) => `$${n.toFixed(2)}`
export const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
