/**
 * Broadcast — the one place this product writes to WhatsApp.
 *
 * Three steps, and the third one is the product. Picking recipients and typing a
 * message are ordinary; the review step is where somebody finds out that eleven
 * of their sixty recipients have never spoken to this number before, that the
 * send will take four minutes, and which handset the recipients will actually
 * see. Everything that makes this safe is on that screen, stated rather than
 * defaulted.
 *
 * The component renders and nothing else. Which chats a source offers, what the
 * search narrows to, what one recipient's copy says and whether the button may
 * be pressed all live in `data/broadcast-compose.ts`, because every one of those
 * has an awkward case and none of them needs a render to test.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Ban, Check, ChevronLeft, ChevronRight, ClipboardList, ListChecks,
  MessageSquare, Search, Send, ShieldCheck, TriangleAlert, Users, X,
} from 'lucide-react'
import { notify } from '@/lib/notify'
import { Empty, Panel, Seg, SkelRows } from '../ui'
import type { LinkedNumber } from '../data/use-follow-ups'
import {
  useBroadcastCandidates, useBroadcastHistory, useBroadcastRun, useBroadcastSend,
  type Broadcast,
} from '../data/use-broadcast'
import {
  MAX_BODY, MAX_RECIPIENTS, filterCandidates, isFinished, pacingLabel,
  parsePasted, pickedFrom, poolFor, progressPct, refusalFor, renderBody,
  summarizeReach, toggleAll, toggleOne,
  type FollowUpList, type PickedRecipient, type PickerFilter, type Source,
} from '../data/broadcast-compose'

const SOURCES: { value: Source; label: string; hint: string; icon: typeof MessageSquare }[] = [
  { value: 'chats', label: 'From your chats', hint: 'People already talking to this number', icon: MessageSquare },
  { value: 'followups', label: 'From a follow-up list', hint: 'Everyone behind an outstanding item', icon: ListChecks },
  { value: 'paste', label: 'Paste numbers', hint: 'Cold reachout — the risky one', icon: ClipboardList },
]

const FILTERS: { value: PickerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dm', label: 'Direct' },
  { value: 'group', label: 'Groups' },
  { value: 'recent', label: 'Active this week' },
  { value: 'quiet', label: 'Gone quiet' },
]

export function BroadcastTab({ numberId, numbers, token }: {
  /** The page-wide number scope. Narrows the picker and picks the sender. */
  numberId?: string
  numbers: LinkedNumber[]
  token?: string
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [source, setSource] = useState<Source>('chats')
  const [list, setList] = useState<FollowUpList>('weowe')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PickerFilter>('all')
  const [pasted, setPasted] = useState('')
  const [body, setBody] = useState('')
  const [label, setLabel] = useState('')
  const [previewIdx, setPreviewIdx] = useState(0)
  /** Set once a send has been accepted. The screen becomes a progress view. */
  const [runId, setRunId] = useState<string | null>(null)

  const candidates = useBroadcastCandidates(token, numberId)
  const history = useBroadcastHistory(token, numberId)
  const { send, sending } = useBroadcastSend(token)

  /** Only a linked handset can send. A dark number would fail at the gateway. */
  const sendable = numbers.filter(n => n.status === 'linked')
  const [from, setFrom] = useState<string>('')
  useEffect(() => {
    // The page scope wins when it names a number; otherwise the first healthy
    // one, so the review step is never showing an empty sender.
    const preferred = numberId && sendable.some(n => n.id === numberId)
      ? numberId
      : sendable[0]?.id ?? ''
    setFrom(preferred)
  }, [numberId, sendable.map(n => n.id).join(',')])

  const pool = useMemo(
    () => poolFor(candidates.candidates, source, list),
    [candidates.candidates, source, list],
  )
  const visible = useMemo(() => filterCandidates(pool, query, filter), [pool, query, filter])

  /** Pasted numbers matched against chats Divo already knows, so a client is not called cold. */
  const knownNames = useMemo(
    () => new Map(candidates.candidates.map(c => [c.waChatId, c.name] as const)),
    [candidates.candidates],
  )
  const pastedResult = useMemo(() => parsePasted(pasted, knownNames), [pasted, knownNames])

  const picked: PickedRecipient[] = source === 'paste'
    ? pastedResult.recipients
    : pickedFrom(pool, selected)

  const reach = summarizeReach(picked)
  const refusal = refusalFor(picked, body)

  const reset = () => {
    setRunId(null); setStep(1); setSelected(new Set()); setPasted('')
    setBody(''); setLabel(''); setPreviewIdx(0)
    history.refresh()
  }

  const confirmSend = async () => {
    if (!from) {
      notify.missing('No number to send from', 'Link a handset on the Numbers tab first.')
      return
    }
    try {
      const result = await send({
        sessionId: from,
        label,
        body,
        recipients: picked.map(r => ({
          waChatId: r.waChatId, displayName: r.name, isGroup: r.isGroup,
        })),
      })
      setRunId(result.broadcastId)
      if (result.unverified.length > 0) {
        // "Sent" and "sent without knowing the number exists" are different
        // claims, and folding the second into the first is exactly the silent
        // degradation the Fail Loudly rules exist to stop.
        notify.heads(
          `${result.unverified.length} could not be checked`,
          'The gateway did not answer the WhatsApp lookup for these, so they were '
          + 'sent to without confirming they exist.',
        )
      }
      if (result.skipped.length > 0) {
        // `heads`, not `failed`. Nothing went wrong — the send is running, these
        // numbers simply are not registered on WhatsApp — but it is worth
        // knowing, and named rather than counted: *which* numbers were dropped
        // decides whether it was a typo or a client who genuinely is not there.
        notify.heads(
          `${result.skipped.length} not on WhatsApp`,
          `Skipped: ${result.skipped.map(id => `+${id.split('@')[0]}`).join(', ')}`,
        )
      }
    } catch (error) {
      // Say who refused and why. "The gateway refused it" was wrong for every
      // case Divo turns down itself — an over-cap list, a chat id it does not
      // recognise — and sent somebody looking at a gateway that was fine.
      notify.failed(
        'Nothing was sent',
        error instanceof Error && error.message ? error.message : 'The send was refused.',
      )
    }
  }

  if (runId) return <RunView broadcastId={runId} token={token} onDone={reset} />

  return (
    <div className="ws-stack">
      {sendable.length === 0 ? (
        <div className="ws-ceiling" role="status">
          <TriangleAlert size={14} aria-hidden />
          <div>
            <b>No number is linked and reading.</b> A broadcast sends from one of your
            handsets, so there is nothing to send from until one is connected.
          </div>
        </div>
      ) : null}

      <Panel>
        <Steps step={step} count={reach.recipients} onGo={setStep} canGo={{
          2: reach.recipients > 0,
          3: reach.recipients > 0 && body.trim().length > 0,
        }} />
      </Panel>

      {step === 1 ? (
        <Audience
          source={source} onSource={value => { setSource(value); setSelected(new Set()); setQuery('') }}
          list={list} onList={value => { setList(value); setSelected(new Set()) }}
          query={query} onQuery={setQuery}
          filter={filter} onFilter={setFilter}
          visible={visible} selected={selected}
          onToggleOne={id => setSelected(prev => toggleOne(prev, id))}
          onToggleAll={() => setSelected(prev => toggleAll(prev, visible))}
          onClear={() => setSelected(new Set())}
          pasted={pasted} onPasted={setPasted}
          rejected={pastedResult.rejected}
          picked={picked} reach={reach} loading={candidates.loading} error={candidates.error} refusal={candidates.refusal}
          truncated={candidates.truncated}
          scoped={numberId ? numbers.find(n => n.id === numberId)?.label ?? null : null}
          onNext={() => setStep(2)}
        />
      ) : null}

      {step === 2 ? (
        <Message
          body={body} onBody={setBody}
          label={label} onLabel={setLabel}
          picked={picked} idx={previewIdx} onIdx={setPreviewIdx}
          fromLabel={numbers.find(n => n.id === from)?.label ?? '—'}
          onBack={() => setStep(1)} onNext={() => setStep(3)}
        />
      ) : null}

      {step === 3 ? (
        <Review
          picked={picked} reach={reach} body={body} refusal={refusal}
          from={from} onFrom={setFrom} sendable={sendable}
          sending={sending}
          onBack={() => setStep(2)} onSend={() => void confirmSend()}
        />
      ) : null}

      <History broadcasts={history.broadcasts} loading={history.loading} error={history.error} refusal={history.refusal} />
    </div>
  )
}

/* ── Steps ──────────────────────────────────────────────────────────────── */

function Steps({ step, count, onGo, canGo }: {
  step: 1 | 2 | 3
  count: number
  onGo: (step: 1 | 2 | 3) => void
  canGo: Record<2 | 3, boolean>
}) {
  const items: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: 'Audience' }, { n: 2, label: 'Message' }, { n: 3, label: 'Review & send' },
  ]
  return (
    <div className="bc-steps">
      {items.map((item, i) => (
        <div className="bc-step-wrap" key={item.n}>
          {i > 0 ? <span className="bc-step-sep" aria-hidden /> : null}
          <button
            type="button"
            className="bc-step"
            data-on={step === item.n}
            data-done={step > item.n}
            // A step you cannot yet satisfy is not clickable. Going forward to an
            // empty Message step and finding the Next button dead is worse than
            // not being able to leave Audience.
            disabled={item.n !== 1 && !canGo[item.n as 2 | 3]}
            onClick={() => onGo(item.n)}
          >
            <span className="n">{step > item.n ? <Check size={11} aria-hidden /> : item.n}</span>
            {item.label}
          </button>
        </div>
      ))}
      <span className="bc-step-count">{count}/{MAX_RECIPIENTS} recipients</span>
    </div>
  )
}

/* ── Step 1: audience ───────────────────────────────────────────────────── */

function Audience(props: {
  source: Source; onSource: (v: Source) => void
  list: FollowUpList; onList: (v: FollowUpList) => void
  query: string; onQuery: (v: string) => void
  filter: PickerFilter; onFilter: (v: PickerFilter) => void
  visible: ReturnType<typeof filterCandidates>
  selected: ReadonlySet<string>
  onToggleOne: (id: string) => void
  onToggleAll: () => void
  onClear: () => void
  pasted: string; onPasted: (v: string) => void
  rejected: string[]
  picked: PickedRecipient[]
  reach: { recipients: number; groups: number; cold: number }
  loading: boolean; error: string | null; refusal: string | null
  /** The server had more chats than it returned. */
  truncated: boolean
  scoped: string | null
  onNext: () => void
}) {
  const allShown = props.visible.length > 0 && props.visible.every(c => props.selected.has(c.waChatId))
  const overCap = props.reach.recipients > MAX_RECIPIENTS

  return (
    <div className="ws-cols">
      <Panel
        title="Who is this going to?"
        description={props.scoped
          ? `Only ${props.scoped}'s conversations are in scope.`
          : 'Every number the team runs is in scope. Narrow it with the number picker above.'}
      >
        <div className="bc-sources">
          {SOURCES.map(({ value, label, hint, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className="bc-source"
              data-on={props.source === value}
              data-risk={value === 'paste'}
              onClick={() => props.onSource(value)}
            >
              <span className="t"><Icon size={14} aria-hidden />{label}</span>
              <span className="h">{hint}</span>
            </button>
          ))}
        </div>

        {props.source === 'paste' ? (
          <div className="ws-panel-body">
            <div className="ws-field">
              <label htmlFor="bc-paste">Numbers, one per line</label>
              <textarea
                id="bc-paste"
                className="input bc-textarea mono"
                placeholder={'+91 98450 12345\n+91 98450 67890'}
                value={props.pasted}
                onChange={e => props.onPasted(e.target.value)}
              />
              {props.rejected.length > 0 ? (
                <p className="hint">
                  Ignored, not a usable number: {props.rejected.slice(0, 4).join(', ')}
                  {props.rejected.length > 4 ? ` and ${props.rejected.length - 4} more` : ''}.
                </p>
              ) : null}
            </div>
            <div className="ws-ceiling bc-danger" style={{ marginTop: 14 }}>
              <TriangleAlert size={14} aria-hidden />
              <div>
                <b>These people have never messaged this number.</b> A first message to a
                stranger is what WhatsApp's abuse systems act on, and the gateway keeps a much
                smaller daily allowance for it than for replies. Every number here is checked
                against WhatsApp before anything is sent.
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="bc-toolbar">
              <div className="bc-search">
                <Search size={13} aria-hidden />
                <input
                  className="input"
                  placeholder="Search chats — name, person, or WhatsApp id…"
                  value={props.query}
                  onChange={e => props.onQuery(e.target.value)}
                />
                {props.query ? (
                  <button type="button" className="bc-clear" onClick={() => props.onQuery('')} aria-label="Clear search">
                    <X size={12} aria-hidden />
                  </button>
                ) : null}
              </div>
              <div className="bc-chips">
                {FILTERS.map(f => (
                  <button
                    key={f.value}
                    type="button"
                    className="ws-chip"
                    data-on={props.filter === f.value}
                    onClick={() => props.onFilter(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {props.source === 'followups' ? (
              <div className="bc-sublist">
                <span className="ws-sub">Build the list from</span>
                <Seg<FollowUpList>
                  value={props.list}
                  onChange={props.onList}
                  options={[
                    { value: 'weowe', label: 'Everyone we owe' },
                    { value: 'waiting', label: 'Everyone we are waiting on' },
                  ]}
                />
              </div>
            ) : null}

            {props.truncated ? (
              <div style={{ padding: '0 18px 12px' }}>
                <div className="ws-ceiling" style={{ margin: 0 }}>
                  <TriangleAlert size={14} aria-hidden />
                  <div>
                    <b>This is not every chat.</b> The list stopped at the page limit, so a
                    conversation you are looking for may exist and not be shown. Narrow it with
                    the number picker or search rather than assuming it is missing.
                  </div>
                </div>
              </div>
            ) : null}

            {props.loading ? <SkelRows n={4} /> : null}

            {!props.loading && props.refusal ? (
              <div className="ws-panel-body">
                <p>{props.refusal}</p>
              </div>
            ) : null}

            {!props.loading && !props.refusal && props.error ? (
              <div className="ws-panel-body">
                <div className="ws-ceiling" style={{ margin: 0 }}>
                  <TriangleAlert size={14} aria-hidden />
                  <div><b>{props.error}</b> Treat this as blank rather than as "no chats".</div>
                </div>
              </div>
            ) : null}

            {!props.loading && !props.refusal && !props.error && props.visible.length === 0 ? (
              <Empty
                icon={Search}
                title="Nothing here to pick"
                body={props.query
                  ? `No chat matches “${props.query}”.`
                  : 'This list is empty for the current source and filter.'}
              />
            ) : null}

            {!props.loading && !props.refusal && !props.error && props.visible.length > 0 ? (
              <>
                <div className="ws-row bc-allrow">
                  <Box on={allShown} onToggle={props.onToggleAll} label="Select all shown" />
                  <div className="ws-row-main">
                    <b>{allShown ? 'Deselect' : 'Select'} all {props.visible.length} shown</b>
                  </div>
                  <div className="ws-row-act">
                    <span className="ws-sub mono">{props.reach.recipients} chosen</span>
                  </div>
                </div>
                <div className="ws-rows bc-list">
                  {props.visible.map(c => (
                    <div
                      className="ws-row click"
                      key={c.waChatId}
                      onClick={() => props.onToggleOne(c.waChatId)}
                    >
                      <Box
                        on={props.selected.has(c.waChatId)}
                        onToggle={() => props.onToggleOne(c.waChatId)}
                        label={`Select ${c.name}`}
                      />
                      <div className="ws-ic">
                        {c.isGroup ? <Users size={14} aria-hidden /> : <MessageSquare size={14} aria-hidden />}
                      </div>
                      <div className="ws-row-main">
                        <b>{c.name}{c.isGroup ? <span className="badge">group</span> : null}</b>
                        <p className="mono">
                          {c.waChatId} · via {c.sessionLabel}
                          {c.openFollowUps > 0 ? ` · ${c.openFollowUps} open` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {props.reach.recipients > 0 ? (
              <div className="bc-tray">
                <span className="bc-tray-n">{props.reach.recipients} selected</span>
                <div className="bc-tray-chips">
                  {props.picked.slice(0, 5).map(r => (
                    <span className="bc-selchip" key={r.waChatId}>
                      {r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name}
                      <button type="button" onClick={() => props.onToggleOne(r.waChatId)} aria-label={`Remove ${r.name}`}>
                        <X size={10} aria-hidden />
                      </button>
                    </span>
                  ))}
                  {props.reach.recipients > 5
                    ? <span className="ws-sub">+{props.reach.recipients - 5} more</span>
                    : null}
                </div>
                <button type="button" className="ws-linkish" onClick={props.onClear}>Clear</button>
              </div>
            ) : null}
          </>
        )}
      </Panel>

      <Panel title="Who this reaches" description="Recomputed as you pick.">
        <div className="ws-panel-body">
          <Kv k="Recipients" v={String(props.reach.recipients)} />
          <Kv k="Group chats" v={String(props.reach.groups)} />
          <Kv k="Never messaged this number" v={String(props.reach.cold)} tone={props.reach.cold ? 'bad' : undefined} />
        </div>

        {props.reach.groups > 0 ? (
          <div className="bc-note">
            <div className="ws-pending">
              <Users size={14} aria-hidden />
              <div>
                <b>{props.reach.groups} of these are groups.</b> One message lands in front of
                everyone in the room, and Divo cannot see how many that is — the gateway's group
                list carries a name and nothing else.
              </div>
            </div>
          </div>
        ) : null}

        {props.reach.cold > 0 ? (
          <div className="bc-note">
            <div className="ws-ceiling bc-danger" style={{ margin: 0 }}>
              <TriangleAlert size={14} aria-hidden />
              <div>
                <b>{props.reach.cold} cold {props.reach.cold === 1 ? 'recipient' : 'recipients'}.</b>{' '}
                The gateway keeps a separate, much smaller daily allowance for first contact.
                This is the part that risks the number.
              </div>
            </div>
          </div>
        ) : null}

        {overCap ? (
          <div className="bc-note">
            <div className="ws-ceiling bc-danger" style={{ margin: 0 }}>
              <Ban size={14} aria-hidden />
              <div>
                <b>Over the {MAX_RECIPIENTS} cap.</b> Remove {props.reach.recipients - MAX_RECIPIENTS} to
                continue — one broadcast is one batch at the gateway, and it takes no more than this.
              </div>
            </div>
          </div>
        ) : null}

        <div className="bc-foot">
          <button
            type="button"
            className="btn primary"
            disabled={props.reach.recipients === 0 || overCap}
            onClick={props.onNext}
          >
            Write the message <ChevronRight size={13} aria-hidden />
          </button>
        </div>
      </Panel>
    </div>
  )
}

/* ── Step 2: message ────────────────────────────────────────────────────── */

function Message(props: {
  body: string; onBody: (v: string) => void
  label: string; onLabel: (v: string) => void
  picked: PickedRecipient[]
  idx: number; onIdx: (v: number) => void
  fromLabel: string
  onBack: () => void; onNext: () => void
}) {
  const who = props.picked[Math.min(props.idx, Math.max(0, props.picked.length - 1))]
  const rendered = who ? renderBody(props.body, who.name) : props.body
  const over = props.body.trim().length > MAX_BODY

  return (
    <div className="ws-cols">
      <Panel
        title="What are you sending?"
        description="One message, personalised per recipient."
        aside={<span className="ws-sub mono" data-over={over}>{props.body.length}/{MAX_BODY}</span>}
      >
        <div className="ws-panel-body">
          <div className="ws-field">
            <label htmlFor="bc-body">Message</label>
            <textarea
              id="bc-body"
              className="input bc-textarea"
              placeholder="Type the message…"
              value={props.body}
              onChange={e => props.onBody(e.target.value)}
            />
            <p className="hint">
              <button
                type="button"
                className="ws-chip"
                onClick={() => props.onBody(`${props.body}{{name}}`)}
              >
                {'{{name}}'}
              </button>
              {' '}Replaced per recipient. A group gets the group's name.
            </p>
          </div>

          <div className="ws-field" style={{ marginTop: 14 }}>
            <label htmlFor="bc-label">Name this broadcast <span className="ws-sub">(optional)</span></label>
            <input
              id="bc-label"
              className="input"
              placeholder="e.g. Monsoon package — warm enquiries"
              value={props.label}
              onChange={e => props.onLabel(e.target.value)}
            />
            <p className="hint">Only shown in the history list. Left blank, the message itself is used.</p>
          </div>

          <div className="ws-pending" style={{ marginTop: 16 }}>
            <ShieldCheck size={14} aria-hidden />
            <div>
              <b>Divo never replies on WhatsApp.</b> This is the one place it writes, and it writes
              only what you type here — the follow-up agent has no send of its own.
            </div>
          </div>
        </div>
        <div className="bc-foot bc-foot-split">
          <button type="button" className="btn" onClick={props.onBack}>
            <ChevronLeft size={13} aria-hidden /> Back to audience
          </button>
          <button type="button" className="btn primary" disabled={!props.body.trim() || over} onClick={props.onNext}>
            Review <ChevronRight size={13} aria-hidden />
          </button>
        </div>
      </Panel>

      <Panel
        title="Preview"
        description="Exactly what one person will see."
        aside={
          <div className="ws-row-act">
            <button type="button" className="btn sm" disabled={props.idx <= 0} onClick={() => props.onIdx(props.idx - 1)} aria-label="Previous recipient">
              <ChevronLeft size={12} aria-hidden />
            </button>
            <span className="ws-sub mono">{props.picked.length ? props.idx + 1 : 0} / {props.picked.length}</span>
            <button type="button" className="btn sm" disabled={props.idx >= props.picked.length - 1} onClick={() => props.onIdx(props.idx + 1)} aria-label="Next recipient">
              <ChevronRight size={12} aria-hidden />
            </button>
          </div>
        }
      >
        <div className="ws-panel-body">
          {who ? (
            <p className="ws-sub" style={{ marginBottom: 10 }}>
              To <b>{who.name}</b> <span className="mono">{who.waChatId}</span>
            </p>
          ) : null}
          <div className="bc-wa">
            <div className="bc-bubble">
              {rendered || <span className="ws-sub">Nothing typed yet.</span>}
              <span className="tm">now ✓✓</span>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <Kv k="Sending as" v={props.fromLabel} />
          </div>
        </div>
      </Panel>
    </div>
  )
}

/* ── Step 3: review ─────────────────────────────────────────────────────── */

function Review(props: {
  picked: PickedRecipient[]
  reach: { recipients: number; groups: number; cold: number }
  body: string
  refusal: string | null
  from: string; onFrom: (v: string) => void
  sendable: LinkedNumber[]
  sending: boolean
  onBack: () => void; onSend: () => void
}) {
  return (
    <div className="ws-cols">
      <Panel title="Before this goes out" description="The things that decide whether this is safe.">
        <div className="ws-panel-body">
          <div className="ws-field">
            <label htmlFor="bc-from">Sending as</label>
            <select
              id="bc-from"
              className="select"
              value={props.from}
              onChange={e => props.onFrom(e.target.value)}
            >
              {props.sendable.map(n => (
                <option key={n.id} value={n.id}>
                  {n.label}{n.phoneE164 ? ` · ${n.phoneE164}` : ''}
                </option>
              ))}
            </select>
            <p className="hint">
              Recipients see this number, and the send is spent against its own daily allowance.
            </p>
          </div>

          <div style={{ marginTop: 14 }}>
            <Kv k="Recipients" v={`${props.reach.recipients} chats`} />
            <Kv k="Group chats" v={String(props.reach.groups)} />
            <Kv
              k="Never messaged this number"
              v={String(props.reach.cold)}
              tone={props.reach.cold ? 'bad' : undefined}
            />
            <Kv k="Paced send takes" v={`${pacingLabel(props.reach.recipients)} · one every 3–5s`} />
          </div>

          <div className="ws-pending" style={{ marginTop: 16 }}>
            <MessageSquare size={14} aria-hidden />
            <div>
              <b>Replies are tracked.</b> These {props.reach.recipients} conversations become
              tracked chats, so anything anybody writes back is read and can turn into a
              follow-up — including the ones who never reply.
            </div>
          </div>
        </div>

        {props.refusal ? (
          <div className="bc-note">
            <div className="ws-ceiling bc-danger" style={{ margin: 0 }}>
              <Ban size={14} aria-hidden />
              <div>{props.refusal}</div>
            </div>
          </div>
        ) : null}

        <div className="bc-foot bc-foot-split">
          <button type="button" className="btn" onClick={props.onBack}>
            <ChevronLeft size={13} aria-hidden /> Back
          </button>
          <button
            type="button"
            className="btn accent"
            disabled={Boolean(props.refusal) || props.sending || !props.from}
            onClick={props.onSend}
          >
            <Send size={13} aria-hidden />
            {props.sending ? 'Sending…' : `Send to ${props.reach.recipients}`}
          </button>
        </div>
      </Panel>

      <Panel title="The message" description="As it was written. Each recipient gets their own name.">
        <div className="ws-panel-body">
          <div className="bc-wa">
            <div className="bc-bubble">
              {props.picked[0] ? renderBody(props.body, props.picked[0].name) : props.body}
              <span className="tm">now ✓✓</span>
            </div>
          </div>
          <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.6 }}>
            Handed to the gateway as one batch with a key of its own. Pressing send twice cannot
            deliver twice — the second attempt is refused by name.
          </p>
        </div>
      </Panel>
    </div>
  )
}

/* ── The run ────────────────────────────────────────────────────────────── */

function RunView({ broadcastId, token, onDone }: {
  broadcastId: string
  token?: string
  onDone: () => void
}) {
  const { broadcast, recipients, error, cancel, cancelling } = useBroadcastRun(broadcastId, token)

  if (!broadcast) return <Panel title="Sending…"><SkelRows n={4} /></Panel>

  const done = isFinished(broadcast.status)
  const pct = progressPct(broadcast.sent, broadcast.failed, broadcast.total)

  return (
    <div className="ws-stack">
      <Panel
        title={broadcast.status === 'sending' || broadcast.status === 'queued'
          ? 'Sending…'
          : broadcast.status === 'cancelled' ? 'Cancelled'
          : broadcast.status === 'failed' ? 'Stopped' : 'Sent'}
        description={`${broadcast.sessionLabel} · ${broadcast.total} recipients · paced one every 3–5 seconds`}
        aside={
          <div className="ws-row-act">
            {done
              ? <button type="button" className="btn sm" onClick={onDone}>New broadcast</button>
              : (
                <button type="button" className="btn sm" disabled={cancelling} onClick={() => void cancel()}>
                  <Ban size={12} aria-hidden /> {cancelling ? 'Stopping…' : 'Cancel'}
                </button>
              )}
          </div>
        }
      >
        <div className="ws-panel-body">
          <div className="ws-bar"><i style={{ width: `${pct}%` }} /></div>
          <div className="bc-counts">
            <span><b className="mono">{broadcast.sent}</b> sent</span>
            <span><b className="mono" data-bad={broadcast.failed > 0}>{broadcast.failed}</b> failed</span>
            <span><b className="mono">{broadcast.pending}</b> pending</span>
            <span className="ws-sub mono">{pct}%</span>
          </div>

          {error ? <p className="ws-sub" style={{ marginTop: 10 }}>{error}</p> : null}

          {broadcast.status === 'cancelled' ? (
            <div className="ws-ceiling" style={{ margin: '16px 0 0' }}>
              <TriangleAlert size={14} aria-hidden />
              <div>
                <b>Stopped part-way.</b> {broadcast.sent} messages had already gone out and cannot
                be recalled. The rest were never sent.
              </div>
            </div>
          ) : null}

          {broadcast.status === 'failed' ? (
            <div className="ws-ceiling bc-danger" style={{ margin: '16px 0 0' }}>
              <TriangleAlert size={14} aria-hidden />
              <div>
                <b>The gateway stopped driving this batch.</b> It abandons anything in flight when
                it restarts, rather than risk sending twice. The list below is the only record of
                which messages had already gone.
              </div>
            </div>
          ) : null}

          {done && broadcast.failed > 0 && broadcast.status === 'completed' ? (
            <div className="ws-ceiling" style={{ margin: '16px 0 0' }}>
              <TriangleAlert size={14} aria-hidden />
              <div>
                <b>{broadcast.failed} did not send.</b> Each one names why below.
              </div>
            </div>
          ) : null}
        </div>

        <div className="ws-rows bc-list">
          {recipients.map(r => (
            <div className="ws-row" key={r.waChatId}>
              <div className="ws-ic">
                {r.isGroup ? <Users size={14} aria-hidden /> : <MessageSquare size={14} aria-hidden />}
              </div>
              <div className="ws-row-main">
                <b>{r.displayName}</b>
                <p className="mono">{r.status === 'failed' && r.error ? r.error : r.waChatId}</p>
              </div>
              <div className="ws-row-act">
                {r.status === 'sent' ? <span className="badge b-ok">sent</span> : null}
                {r.status === 'failed' ? <span className="badge b-err">failed</span> : null}
                {r.status === 'pending' ? <span className="badge">waiting</span> : null}
                {r.status === 'cancelled' ? <span className="badge b-warn">not sent</span> : null}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

/* ── History ────────────────────────────────────────────────────────────── */

function History({ broadcasts, loading, error, refusal }: { broadcasts: Broadcast[]; loading: boolean; error: string | null; refusal: string | null }) {
  if (loading) return null
  if (refusal) {
    return (
      <Panel title="History">
        <div className="ws-panel-body">
          <p>{refusal}</p>
        </div>
      </Panel>
    )
  }
  if (error) {
    return (
      <Panel title="History">
        <div className="ws-panel-body">
          <div className="ws-ceiling">
            <TriangleAlert size={14} aria-hidden />
            <div><b>{error}</b> Treat this as blank rather than as "no history".</div>
          </div>
        </div>
      </Panel>
    )
  }
  if (broadcasts.length === 0) return null

  return (
    <Panel
      title="Earlier broadcasts"
      description="Every send is recorded with who asked for it and what happened to each recipient."
    >
      <div className="ws-rows">
        {broadcasts.map(b => (
          <div className="ws-row" key={b.id}>
            <div className="ws-ic"><Send size={14} aria-hidden /></div>
            <div className="ws-row-main">
              <b>
                {b.label}
                {b.failed > 0
                  ? <span className="badge b-warn">{b.failed} failed</span>
                  : b.status === 'completed'
                    ? <span className="badge b-ok">all delivered</span>
                    : <span className="badge">{b.status}</span>}
              </b>
              <p className="mono">
                {new Date(b.createdAt).toLocaleString(undefined, {
                  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
                })}
                {' · '}from {b.sessionLabel} · {b.sent}/{b.total} sent
                {b.requestedByName ? ` · started by ${b.requestedByName}` : ''}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/* ── Bits ───────────────────────────────────────────────────────────────── */

/**
 * A checkbox that is a button.
 *
 * `stopPropagation` because the whole row is clickable: without it, clicking the
 * box toggles the row *and* the box, which cancels out and reads as a control
 * that does nothing.
 */
function Box({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      className="bc-box"
      data-on={on}
      aria-pressed={on}
      aria-label={label}
      onClick={e => { e.stopPropagation(); onToggle() }}
    >
      {on ? <Check size={11} aria-hidden /> : null}
    </button>
  )
}

function Kv({ k, v, tone }: { k: string; v: string; tone?: 'bad' }) {
  return (
    <div className="bc-kv">
      <span className="k">{k}</span>
      <span className="v" data-tone={tone}>{v}</span>
    </div>
  )
}
