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

export const Skel = ({ w, h = 11, circle }: { w?: number | string; h?: number; circle?: boolean }) => (
  <div
    className={`ws-skel${circle ? ' circle' : ' line'}`}
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
}: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="ws-ph">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 style={{ marginTop: eyebrow ? 7 : 0 }}>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
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
export function Prompt({ title, description, label, placeholder, confirm, secret, initial, onConfirm, onClose }: {
  title: string
  description?: string
  label: string
  placeholder?: string
  confirm: string
  /** Masks the field and stops the browser offering to remember it. */
  secret?: boolean
  /**
   * Seeds the field — for renames, where the current value is what you are
   * editing rather than a hint. Never combine with `secret`.
   */
  initial?: string
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
    if (!value.trim() || busy) return
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
          </div>
          <div className="ws-modal-f">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !value.trim()}>
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

/* ── Provenance ───────────────────────────────────────
   The backend already tells us WHY a permission resolved. Showing it is the
   difference between a matrix people fear and one they can reason about. */
export const Provenance = ({ source }: { source: PermissionSource }) => (
  <span className="ws-prov" data-src={source}>{SOURCE_LABEL[source]}</span>
)

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
export function permissionSentence(person: Person): { can: string[]; cannot: string[] } {
  const grants = resolveGrants(person)
  const can: string[] = []
  for (const [toolId, actions] of Object.entries(grants)) {
    const tool = toolById(toolId)
    if (!tool) continue
    for (const [action, grant] of Object.entries(actions)) {
      if (!grant?.allowed) continue
      const phrase = tool.verb[action as ActionGroup]
      if (phrase) can.push(phrase)
    }
  }
  const cannot: string[] = []
  for (const tool of TOOLS_WITH_VERBS) {
    const held = grants[tool.id]
    for (const action of tool.actions) {
      if (held?.[action]?.allowed) continue
      const phrase = tool.verb[action]
      if (phrase && SENSITIVE.has(`${tool.id}:${action}`)) cannot.push(phrase)
    }
  }
  return { can: dedupe(can), cannot: dedupe(cannot) }
}

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
export function Matrix({ grants, onToggle, readOnly, tools }: {
  grants: GrantMap
  onToggle?: (toolId: string, action: ActionGroup) => void
  readOnly?: boolean
  tools: typeof TOOLS
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="ws-matrix">
        <thead>
          <tr>
            <th>Tool</th>
            {ACTION_GROUPS.map((a) => <th key={a} className="act">{a}</th>)}
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.id}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ fontWeight: 500 }}>{tool.name}</span>
                  <span className="ws-sub">{tool.family}</span>
                </div>
              </td>
              {ACTION_GROUPS.map((action) => {
                const supported = tool.actions.includes(action)
                if (!supported) return <td key={action} className="act"><span className="ws-cell-na">·</span></td>
                const grant = grants[tool.id]?.[action]
                const on = Boolean(grant?.allowed)
                const locked = !ceilingAllows(tool.id, action)
                return (
                  <td key={action} className="act">
                    <button
                      type="button"
                      className="ws-cell"
                      data-on={on}
                      data-src={grant?.source}
                      data-locked={locked || readOnly}
                      disabled={locked || readOnly}
                      title={
                        locked
                          ? `Company policy blocks ${action} on ${tool.name} for this role`
                          : grant
                            ? `${on ? 'Allowed' : 'Blocked'} — ${SOURCE_LABEL[grant.source]}`
                            : 'Not granted'
                      }
                      onClick={() => onToggle?.(tool.id, action)}
                    >
                      {locked ? <Lock size={11} /> : on ? <Check size={13} /> : null}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A pending permission edit, shown as a diff before it is applied. */
export type PendingChange = { toolId: string; action: ActionGroup; next: boolean; blocked?: boolean }

export function ChangePreview({ person, changes, onApply, onCancel }: {
  person: Person; changes: PendingChange[]; onApply: () => void; onCancel: () => void
}) {
  if (changes.length === 0) return null
  return (
    <div className="ws-diff">
      <div className="ws-diff-h">
        <ChevronRight size={14} />
        {changes.length} change{changes.length > 1 ? 's' : ''} for {person.name.split(' ')[0]}, not saved yet
      </div>
      <div className="ws-diff-l">
        {changes.map((c) => {
          const tool = toolById(c.toolId)
          const kind = c.blocked ? 'blocked' : c.next ? 'add' : 'remove'
          return (
            <div className="ws-diff-i" key={`${c.toolId}:${c.action}`} data-k={kind}>
              <span className="sg">{c.blocked ? '!' : c.next ? '+' : '−'}</span>
              <span>
                {c.next ? 'Can' : 'Can no longer'} <b>{tool?.verb[c.action] ?? `${c.action} ${tool?.name}`}</b>
              </span>
              {c.blocked ? <small>blocked by company policy</small> : null}
            </div>
          )
        })}
      </div>
      <div className="ws-diff-f">
        <button type="button" className="btn" onClick={onCancel}>Discard</button>
        <button type="button" className="btn primary" onClick={onApply}>Apply {changes.length}</button>
      </div>
    </div>
  )
}

export const Ceiling = ({ children }: { children: ReactNode }) => (
  <div className="ws-ceiling"><AlertTriangle size={14} />{<div>{children}</div>}</div>
)

/* ── Provider glyphs ─────────────────────────────────
   Wordmark initials rather than logos — no brand assets to license, and it
   keeps the palette to the two neutrals the design language allows. */
const PROVIDER_META: Record<Provider, { short: string; name: string }> = {
  google_workspace: { short: 'G', name: 'Google Workspace' },
  lark: { short: 'L', name: 'Lark' },
  canva: { short: 'C', name: 'Canva' },
  airtable: { short: 'A', name: 'Airtable' },
  aitable: { short: 'Ai', name: 'AITable' },
  zoho: { short: 'Z', name: 'Zoho' },
}

export const ProviderMark = ({ provider }: { provider: Provider }) => (
  <span className="ws-ic" aria-hidden>
    <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em' }}>{PROVIDER_META[provider].short}</span>
  </span>
)

export const providerName = (p: Provider) => PROVIDER_META[p].name

export function useToast() {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const show = (m: string) => {
    setMessage(m)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMessage(null), 2600)
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  return { message, show }
}

export const money = (n: number) => `$${n.toFixed(2)}`
export const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function useDelta(current: number, previous: number) {
  return useMemo(() => {
    if (previous === 0) return null
    const pct = Math.round(((current - previous) / previous) * 100)
    return { pct, up: pct >= 0 }
  }, [current, previous])
}
