/**
 * Follow-ups — the loose ends across every WhatsApp number the team runs.
 *
 * One shared pool. Nothing is assigned to anybody, so there is no "mine" filter
 * and no owner picker: `ownerLabel` names a *side* — "We owe", "Waiting on
 * Priya" — and it is composed on the server so one rule decides the wording.
 *
 * The numbers panel is not decoration. A handset that logs out stops producing
 * follow-ups while the page underneath still looks healthy, and silence from a
 * dead number is indistinguishable from a quiet week. That is why a number that
 * came back but has not been re-read gets its own state rather than being
 * folded into "connected".
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Check, ChevronDown, Clock, MessageSquare, Plug, Plus, RefreshCw, Search, TriangleAlert, X,
} from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { holds } from '../data/capabilities'
import { notify } from '@/lib/notify'
import {
  useFollowUps, useLinkedNumbers, useTrackedChats,
  useDigest,
  type FollowUp, type FollowUpAction, type LinkedNumber,
} from '../data/use-follow-ups'
import {
  needsAttention, numberState, sinceLabel, summarizeFollowUps,
  type NumberState,
} from '../data/follow-up-summary'
import {
  filterScopeNumbers, openCountsByNumber, scopePillLabel, scopeRow,
} from '../data/scope-selector'
import { Empty, Fade, PageHeader, Panel, RowMenu, Seg, SkelRows, Switch } from '../ui'
import { LinkNumberFlow } from './link-number-dialog'
import { BroadcastTab } from './broadcast-tab'
import { DigestTab } from './digest-tab'

/** What each number state says, and how loudly. */
const NUMBER_STATE: Record<NumberState, { label: string; tone: string }> = {
  healthy: { label: 'Reading', tone: 'b-ok' },
  quiet: { label: 'No messages lately', tone: 'b-warn' },
  // Linked and working; nobody has messaged it yet. Toneless because it is
  // neither good news nor bad — the alarm belongs to `quiet`, which means a
  // number that *was* being read and went silent.
  new: { label: 'Waiting for first message', tone: '' },
  gap: { label: 'Messages missing', tone: 'b-err' },
  dark: { label: 'Not connected', tone: 'b-err' },
  // Neither good nor bad — it is a step somebody is part-way through.
  pending: { label: 'Waiting to be linked', tone: '' },
}

const URGENCY_TONE: Record<string, string> = {
  high: 'b-err', medium: 'b-warn', low: '',
}

const dueLabel = (iso: string | null): string | null => {
  if (!iso) return null
  const due = new Date(iso)
  const days = Math.round((due.getTime() - Date.now()) / 86_400_000)
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  return `due ${due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

/**
 * Five tabs, and the last two are different verbs.
 *
 * Broadcast sits here rather than in its own sidebar item because it reuses two
 * things this page already owns: the number scope and the chat list. A separate
 * page would duplicate both, and the duplicate scope control is the one that
 * would drift.
 *
 * Digest is here for the same reason and answers about this page's own output:
 * when the team is told what is outstanding, and whether the last one actually
 * went. Both are Divo acting outward rather than a view of the list, which is
 * why they sit together at the end and share one permission.
 */
type Tab = 'open' | 'numbers' | 'chats' | 'broadcast' | 'digest'

export function FollowUpsScreen() {
  const { token, session } = useAdminAuth()
  const capabilities = (session as unknown as { capabilities?: Record<string, readonly string[]> | null })?.capabilities ?? null
  const canBroadcast = holds(capabilities, 'followUps', 'send')
  const [tab, setTab] = useState<Tab>('open')

  useEffect(() => {
    if (!canBroadcast && (tab === 'broadcast' || tab === 'digest')) setTab('open')
  }, [canBroadcast, tab])
  // Set by the digest card's link, so tapping one number's card lands on that
  // number rather than the whole team's list.
  const [params, setParams] = useSearchParams()
  const numberId = params.get('number') ?? undefined

  // `token` is nullable while auth resolves; the hooks take `undefined` and
  // simply do not fetch, which is the same "not yet" the shell already renders.
  const auth = token ?? undefined
  const items = useFollowUps(auth, numberId)
  const numbers = useLinkedNumbers(auth)
  const chats = useTrackedChats(auth, numberId)
  // Read here rather than inside the tab so the schedule is already in hand
  // when somebody opens it, the same way the other tabs' data is.
  const digest = useDigest(auth)
  // Global counts for the scope menu — the menu must show the whole team's
  // pool even when the list is narrowed, otherwise "All numbers (2)" would
  // read as the total when it is only one handset's.
  const globalCounts = useFollowUps(auth)
  const followUpsForCounts = numberId ? globalCounts.followUps : items.followUps
  /**
   * The link dialog lives here, not inside the Numbers panel.
   *
   * `Panel` renders its children straight into `.ws-panel`, so a dialog opened
   * from inside one is a panel child rather than a page overlay — it inherits
   * the panel's stacking context and sits inside its border. An overlay belongs
   * to the screen.
   */
  const [linking, setLinking] = useState(false)

  const summary = useMemo(() => summarizeFollowUps(items.followUps), [items.followUps])
  const attention = numbers.numbers.filter(needsAttention)
  // Named rather than shown as a raw id. A filter nobody can read is a filter
  // nobody realises is on, and a filtered list that looks unfiltered reads as
  // "the team has almost nothing outstanding".
  const filteredTo = numberId
    ? numbers.numbers.find(number => number.id === numberId)
    : undefined
  const filteredLabel = numberId ? (filteredTo?.label ?? 'one number') : null

  const handleScopeSelect = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('number', id)
    else next.delete('number')
    setParams(next, { replace: true })
  }

  return (
    <Fade>
      <PageHeader
        eyebrow="WhatsApp"
        title="Follow-ups"
        description="Everything the team owes, and everything the team is waiting on, read from every linked number."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ScopeSelector
              numbers={numbers.numbers}
              followUps={followUpsForCounts}
              numberId={numberId}
              onSelect={handleScopeSelect}
            />
            <Seg<Tab>
              value={tab}
              onChange={setTab}
              options={(() => {
                const opts: { value: Tab; label: string }[] = [
                  { value: 'open', label: `Open${summary.total ? ` (${summary.total})` : ''}` },
                  { value: 'numbers', label: `Numbers${attention.length ? ` (${attention.length})` : ''}` },
                  { value: 'chats', label: 'Chats' },
                ]
                if (canBroadcast) {
                  opts.push({ value: 'broadcast', label: 'Broadcast' })
                  opts.push({ value: 'digest', label: 'Digest' })
                }
                return opts
              })()}
            />
          </div>
        }
      />

      {/*
        Raised above the tabs rather than inside Numbers. A number that is not
        being read makes every count on this page an undercount, and somebody
        looking at Open would otherwise never find out.
      */}
      {attention.length > 0 && tab !== 'numbers' ? (
        <div className="ws-ceiling" role="status">
          <TriangleAlert size={14} aria-hidden />
          <div>
            <b>
              {attention.length === 1
                ? `${attention[0]!.label} is not being read.`
                : `${attention.length} numbers are not being read.`}
            </b>
            {' '}Follow-ups from {attention.length === 1 ? 'it' : 'them'} are missing from this
            list, so treat the counts below as an undercount.{' '}
            <button type="button" className="ws-linkish" onClick={() => setTab('numbers')}>
              Show numbers
            </button>
          </div>
        </div>
      ) : null}

      {linking ? (
        <LinkNumberFlow
          token={auth}
          onCreate={numbers.create}
          onLinked={numbers.refresh}
          onClose={() => setLinking(false)}
        />
      ) : null}

      {tab === 'open' ? (
        <OpenTab
          items={items}
          summary={summary}
          filteredTo={filteredLabel}
          onClearFilter={() => setParams({}, { replace: true })}
        />
      ) : null}
      {tab === 'numbers' ? <NumbersTab numbers={numbers} onLink={() => setLinking(true)} /> : null}
      {tab === 'chats' ? <ChatsTab chats={chats} numberId={numberId} /> : null}
      {tab === 'broadcast' ? (
        <BroadcastTab
          {...(numberId ? { numberId } : {})}
          numbers={numbers.numbers}
          {...(auth ? { token: auth } : {})}
        />
      ) : null}
      {tab === 'digest' ? (
        <DigestTab
          digest={digest.digest}
          cards={digest.cards}
          loading={digest.loading}
          error={digest.error}
          refusal={digest.refusal}
          save={digest.save}
        />
      ) : null}
    </Fade>
  )
}

/**
 * How long "snooze" pushes a nudge out.
 *
 * Two options, not a picker. The real question a person is answering is "not
 * now" or "not this week", and a date field invites a precision nobody has
 * about a reminder.
 */
const SNOOZE = [
  { label: 'Snooze until tomorrow', hours: 24 },
  { label: 'Snooze for a week', hours: 24 * 7 },
] as const

function OpenTab({ items, summary, filteredTo, onClearFilter }: {
  items: ReturnType<typeof useFollowUps>
  summary: ReturnType<typeof summarizeFollowUps>
  /** The number this list is narrowed to, or null when it is the whole pool. */
  filteredTo: string | null
  onClearFilter: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (item: FollowUp, action: FollowUpAction, said: string) => {
    const isDone = action.action === 'done'
    const captured = item
    setBusy(item.id)
    try {
      await items.act(item.id, action)
      if (isDone) {
        notify.done(said, captured.title, {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await items.act(captured.id, { action: 'reopen' })
                notify.done('Put back', captured.title)
              } catch {
                notify.failed('Could not put back', `${captured.title} is still done.`)
              }
            })()
          },
        })
      } else {
        notify.done(said, item.title)
      }
    } catch {
      notify.failed('That did not save', `${item.title} is unchanged.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      title={filteredTo ? `Open follow-ups — ${filteredTo}` : 'Open follow-ups'}
      description={filteredTo
        ? 'Only this number\u2019s conversations. The rest of the team\u2019s follow-ups are not shown.'
        : 'Ordered by urgency, then by how soon they are due.'}
      aside={
        <div className="ws-row-act">
          {filteredTo ? (
            <button type="button" className="ws-linkish" onClick={onClearFilter}>
              Show every number
            </button>
          ) : null}
          <span className="badge">{summary.weOwe} we owe</span>
          <span className="badge">{summary.waiting} waiting</span>
          {summary.overdue > 0
            ? <span className="badge b-err"><span className="dot" />{summary.overdue} overdue</span>
            : null}
        </div>
      }
      footer={
        // Fail Loudly: a capped list must say it is capped, or a team reads
        // "that is everything" from a page that is showing a slice.
        items.truncated
          ? <p>Showing the first 100 — there are more than this.</p>
          : null
      }
    >
      {items.loading ? <SkelRows n={4} /> : null}

      {!items.loading && items.refusal ? (
        <div className="ws-panel-body">
          <p>{items.refusal}</p>
        </div>
      ) : null}

      {!items.loading && !items.refusal && items.error ? (
        <div className="ws-panel-body">
          <div className="ws-ceiling">
            <TriangleAlert size={14} aria-hidden />
            <div><b>{items.error}</b> Treat this list as blank rather than as "nothing outstanding".</div>
          </div>
        </div>
      ) : null}

      {!items.loading && !items.refusal && !items.error && items.followUps.length === 0 ? (
        <Empty
          icon={MessageSquare}
          title={filteredTo ? `Nothing outstanding on ${filteredTo}` : 'Nothing outstanding'}
          body={filteredTo
            ? 'This number is clear. Other numbers may still have follow-ups.'
            : 'Every commitment and question Divo has read from your WhatsApp numbers is answered.'}
          {...(filteredTo ? {
            action: (
              <button type="button" className="btn" onClick={onClearFilter}>
                Show every number
              </button>
            ),
          } : {})}
        />
      ) : null}

      {!items.loading && !items.refusal && !items.error && items.followUps.length > 0 ? (
        <div className="ws-rows">
          {items.followUps.map(item => {
            const due = dueLabel(item.dueDate)
            return (
              <div className="ws-row" key={item.id}>
                <div className="ws-row-main">
                  <b>
                    <span className={`badge ${URGENCY_TONE[item.urgency] ?? ''}`}>
                      {item.ownerLabel}
                    </span>
                    {item.title}
                  </b>
                  <p>
                    {item.chatName ?? 'Unknown chat'}
                    {due ? ` · ${due}` : ''}
                    {item.detail ? ` · ${item.detail}` : ''}
                  </p>
                </div>
                <div className="ws-row-act">
                  {/*
                    Done gets its own button; the rest go behind the menu. It is
                    the action almost every item ends in, and burying the common
                    case behind a menu is how a list stops being kept up to date.
                  */}
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy === item.id}
                    onClick={() => void act(item, { action: 'done' }, 'Marked done')}
                  >
                    <Check size={13} aria-hidden />
                    Done
                  </button>
                  <RowMenu
                    label="More actions"
                    busy={busy === item.id}
                    items={[
                      ...SNOOZE.map(option => ({
                        label: option.label,
                        icon: Clock,
                        onSelect: () => void act(
                          item, { action: 'snooze', hours: option.hours }, option.label,
                        ),
                      })),
                      {
                        label: 'Not a follow-up',
                        icon: X,
                        danger: true,
                        // Distinct from Done on purpose. "We finished this" and
                        // "this was never a real commitment" are different
                        // facts, and only the second one says the analysis was
                        // wrong.
                        onSelect: () => void act(
                          item,
                          { action: 'dismiss', reason: 'not a follow-up' },
                          'Dismissed',
                        ),
                      },
                    ]}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </Panel>
  )
}

function NumbersTab({ numbers, onLink }: {
  numbers: ReturnType<typeof useLinkedNumbers>
  /** Opens the link dialog, which the screen owns — see the note there. */
  onLink: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const reread = async (number: LinkedNumber) => {
    setBusy(number.id)
    try {
      const result = await numbers.reread(number.id)
      if (result.unsupported) {
        // Not a failure to retry. The list refreshes with `historySupported`
        // false, so the control disappears rather than inviting another go.
        notify.done(
          `Divo reads ${number.label} from now on`,
          'This WhatsApp connection cannot fetch older messages, so past conversations stay invisible. '
          + 'Anything sent from here on is read normally.',
        )
        return
      }
      if (!result.complete) {
        // A partial repair leaves the gap marker in place. Saying "done" would
        // retire the only signal that messages are still missing.
        notify.failed(
          `${number.label} was only partly re-read`,
          `Recovered ${result.messagesRecovered} message${result.messagesRecovered === 1 ? '' : 's'}, `
          + `but ${result.failures.length} chat${result.failures.length === 1 ? '' : 's'} could not be read. `
          + 'It is still marked as missing messages.',
        )
        return
      }
      notify.done(
        result.messagesRecovered === 0
          ? `Nothing was missing from ${number.label}`
          : `Re-read ${number.label}`,
        result.messagesRecovered === 0
          ? `Read ${result.chatsRead} chats and found nothing Divo did not already have.`
          : `Recovered ${result.messagesRecovered} message${result.messagesRecovered === 1 ? '' : 's'} across ${result.chatsRead} chats.`,
      )
    } catch {
      notify.failed(`Could not re-read ${number.label}`, 'The WhatsApp gateway did not answer.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      title="Numbers"
      description="Each linked handset, and whether Divo is actually reading it."
      aside={
        <button type="button" className="btn sm" onClick={onLink}>
          <Plus size={13} aria-hidden />
          Link a number
        </button>
      }
    >

      {numbers.loading ? <SkelRows n={3} /> : null}

      {!numbers.loading && numbers.refusal ? (
        <div className="ws-panel-body">
          <p>{numbers.refusal}</p>
        </div>
      ) : null}

      {!numbers.loading && !numbers.refusal && numbers.error ? (
        <div className="ws-panel-body">
          <div className="ws-ceiling">
            <TriangleAlert size={14} aria-hidden />
            <div><b>{numbers.error}</b> Treat this as blank rather than as "no numbers linked".</div>
          </div>
        </div>
      ) : null}

      {!numbers.loading && !numbers.refusal && !numbers.error && numbers.numbers.length === 0 ? (
        <Empty
          icon={Plug}
          title="No numbers linked yet"
          body="Link a WhatsApp number and Divo starts reading its conversations for loose ends."
        />
      ) : null}

      {!numbers.loading && !numbers.refusal && !numbers.error && numbers.numbers.length > 0 ? (
        <div className="ws-rows">
          {numbers.numbers.map(number => {
            const state = numberState(number)
            const meta = NUMBER_STATE[state]
            return (
              <div className="ws-row" key={number.id}>
                <div className="ws-row-main">
                  <b>
                    <span className={`badge ${meta.tone}`}>
                      {meta.tone ? <span className="dot" /> : null}{meta.label}
                    </span>
                    {number.label}
                  </b>
                  <p>
                    {number.phoneE164 ?? 'Number not known yet'}
                    {' · last message '}{sinceLabel(number.lastSeenAt)}
                    {number.darkSince
                      ? ` · missing messages since ${new Date(number.darkSince).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                      : ''}
                  </p>
                </div>
                <div className="ws-row-act">
                  {/*
                    Offered whenever a number is worth looking at, not only when
                    it is dark. Running it on a healthy number is a no-op — every
                    message goes through the same unique key the webhook writes
                    through — so the cost of pressing it needlessly is time.

                    Withheld entirely when the gateway's engine has no history
                    call: a control that cannot succeed is worse than no control,
                    because the person who presses it and watches it fail stops
                    believing the rest of the page.
                  */}
                  {needsAttention(number) && numbers.historySupported ? (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy === number.id}
                      onClick={() => void reread(number)}
                    >
                      <RefreshCw size={13} aria-hidden />
                      {busy === number.id ? 'Re-reading…' : 'Re-read history'}
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </Panel>
  )
}


/**
 * Scope selector — one pill that narrows every tab.
 *
 * Ten numbers is a scope, not ten tabs: the pill sits left of the Seg and
 * controls Open, Chats and Broadcast together. The URL is the single source
 * of truth — selecting a number writes `?number=<id>` via the router, and
 * clearing it removes the param. No component state for the selection itself.
 */
function ScopeSelector({
  numbers,
  followUps,
  numberId,
  onSelect,
}: {
  numbers: LinkedNumber[]
  followUps: FollowUp[]
  numberId?: string
  onSelect: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-scope-menu]') || target.closest('[data-scope-pill]')) return
      setOpen(false)
      setQuery('')
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open])

  const pillLabel = scopePillLabel(numberId, numbers)
  const active = numberId ? numbers.find(n => n.id === numberId) : undefined
  const dotColor = (() => {
    if (!active) return 'var(--cur-hairline-hover)'
    const state = numberState(active)
    if (state === 'healthy') return 'var(--bui-green)'
    if (state === 'quiet') return 'var(--bui-orange)'
    if (state === 'gap' || state === 'dark') return 'var(--bui-red)'
    return 'var(--cur-hairline-hover)'
  })()

  const counts = useMemo(() => openCountsByNumber(followUps), [followUps])
  const totalOpen = followUps.length
  const showSearch = numbers.length > 6
  const filtered = useMemo(() => filterScopeNumbers(numbers, query), [numbers, query])

  return (
    <div style={{ position: 'relative' }} data-scope-pill>
      <button
        type="button"
        className="btn sm"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: 270 }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flex: '0 0 8px',
            background: dotColor,
          }}
        />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500 }}>
          {pillLabel}
        </span>
        {numberId ? (
          <span
            role="button"
            tabIndex={0}
            onClick={e => {
              e.stopPropagation()
              onSelect(null)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onSelect(null)
              }
            }}
            style={{
              marginLeft: 2,
              padding: 3,
              borderRadius: 5,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--cur-muted)',
            }}
            aria-label="Clear scope"
          >
            <X size={12} aria-hidden />
          </span>
        ) : (
          <ChevronDown size={13} aria-hidden style={{ color: 'var(--cur-muted)', flexShrink: 0 }} />
        )}
      </button>
      {open ? (
        <div
          data-scope-menu
          className="ws-menu"
          style={{
            left: 0,
            right: 'auto',
            width: 340,
            maxHeight: 380,
            display: 'flex',
            flexDirection: 'column',
            padding: 0,
            overflow: 'hidden',
          }}
          role="menu"
        >
          {showSearch ? (
            /*
             * `.search`, the class every other search box in the workspace
             * uses. It already lays the icon over the input, so nothing here
             * positions anything by hand — an invented class with inline
             * positioning behind it looks the same on the day it is written and
             * stops matching the moment the real one is restyled.
             */
            <div style={{ padding: 8, borderBottom: '1px solid var(--cur-hairline)' }}>
              <div className="search">
                <Search size={13} aria-hidden />
                <input
                  placeholder="Find a number…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
              </div>
            </div>
          ) : null}
          <div style={{ maxHeight: 290, overflowY: 'auto', padding: 4 }}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!numberId}
              onClick={() => {
                onSelect(null)
                setOpen(false)
                setQuery('')
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                padding: '8px 9px',
                border: 0,
                borderRadius: 7,
                background: !numberId ? 'var(--cur-canvas-soft)' : 'transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flex: '0 0 8px',
                  background: 'var(--cur-hairline-hover)',
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ display: 'block', fontSize: '12.5px', fontWeight: 500, color: 'var(--cur-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  All numbers
                </b>
                <span style={{ display: 'block', fontSize: '10.5px', color: 'var(--cur-muted)', fontFamily: '"JetBrains Mono", monospace', marginTop: 2 }}>
                  the whole team&apos;s pool
                </span>
              </span>
              <span style={{ fontSize: '11px', color: 'var(--cur-muted)', fontFamily: '"JetBrains Mono", monospace', flexShrink: 0 }}>
                {totalOpen}
              </span>
            </button>
            <div className="ws-menu-sep" style={{ height: 1, background: 'var(--cur-hairline)', margin: '4px 6px' }} />
            {filtered.map(n => {
              const row = scopeRow(n, counts.get(n.id) ?? 0)
              const isActive = numberId === n.id
              const dotBg =
                row.healthDot === 'ok'
                  ? 'var(--bui-green)'
                  : row.healthDot === 'warn'
                    ? 'var(--bui-orange)'
                    : row.healthDot === 'err'
                      ? 'var(--bui-red)'
                      : 'var(--cur-hairline-hover)'
              return (
                <button
                  key={n.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    onSelect(n.id)
                    setOpen(false)
                    setQuery('')
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 9px',
                    border: 0,
                    borderRadius: 7,
                    background: isActive ? 'var(--cur-canvas-soft)' : 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      flex: '0 0 8px',
                      background: dotBg,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ display: 'block', fontSize: '12.5px', fontWeight: 500, color: 'var(--cur-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.label}
                    </b>
                    <span style={{ display: 'block', fontSize: '10.5px', color: 'var(--cur-muted)', fontFamily: '"JetBrains Mono", monospace', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.phone} · {row.stateLabel}
                    </span>
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--cur-muted)', fontFamily: '"JetBrains Mono", monospace', flexShrink: 0 }}>
                    {row.count || '—'}
                  </span>
                </button>
              )
            })}
            {filtered.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--cur-muted)' }}>
                No number matches &quot;{query}&quot;
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ChatsTab({ chats, numberId }: { chats: ReturnType<typeof useTrackedChats>; numberId?: string }) {
  return (
    <Panel
      title="Chats"
      description="Every conversation Divo has seen. Switch one off and it stops being read from the next sweep."
      footer={
        <p>
          Direct messages are read like group chats, because most client work happens
          one to one. Switch off any conversation that should not be.
        </p>
      }
    >
      {chats.loading ? <SkelRows n={4} /> : null}

      {!chats.loading && chats.refusal ? (
        <div className="ws-panel-body">
          <p>{chats.refusal}</p>
        </div>
      ) : null}

      {!chats.loading && !chats.refusal && chats.error ? (
        <div className="ws-panel-body">
          <div className="ws-ceiling">
            <TriangleAlert size={14} aria-hidden />
            <div><b>{chats.error}</b> Treat this as blank rather than as "no conversations".</div>
          </div>
        </div>
      ) : null}

      {!chats.loading && !chats.refusal && !chats.error && chats.chats.length === 0 ? (
        <Empty
          icon={MessageSquare}
          title="No conversations yet"
          body="Once a number is linked, the chats it can see appear here."
        />
      ) : null}

      {!chats.loading && !chats.refusal && !chats.error && chats.chats.length > 0 ? (
        <div className="ws-rows">
          {chats.chats.map(chat => (
            <div className="ws-row" key={chat.id} data-on={!chat.muted}>
              <div className="ws-row-main">
                <b>
                  {chat.name ?? 'Unnamed chat'}
                  {chat.isGroup ? <span className="badge">Group</span> : null}
                  {chat.openFollowUps > 0
                    ? <span className="badge">{chat.openFollowUps} open</span>
                    : null}
                </b>
                <p>
                  {chat.lastMessageAt
                    ? `last message ${sinceLabel(chat.lastMessageAt)} ago`
                    : 'no messages yet'}
                  {chat.lastAnalyzedAt ? ` · read ${sinceLabel(chat.lastAnalyzedAt)} ago` : ' · not read yet'}
                </p>
              </div>
              <div className="ws-row-act">
                <Switch
                  on={!chat.muted}
                  onToggle={() => void chats.setMuted(chat.id, !chat.muted)}
                  label={chat.muted ? `Start reading ${chat.name ?? 'this chat'}` : `Stop reading ${chat.name ?? 'this chat'}`}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  )
}
