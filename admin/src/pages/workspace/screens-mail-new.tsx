/**
 * New mail rule — the shell.
 *
 * THIS SCREEN CREATES NOTHING. There is no HTTP route for making a mail rule;
 * `MailOpsService.createRuleForMailbox` exists and is reachable only through
 * the agent's tool surface, so a rule is still made by asking Divo. What is
 * here is the shape of the flow, so the arrangement can be judged before the
 * behaviour is built.
 *
 * Two things are deliberately absent, and are the next piece of work:
 *
 *  - **Compiling a sentence into conditions.** The describe box accepts text
 *    and does nothing with it. Faking that step — regex in the browser,
 *    guessing at "from acme.com" — would be the worst possible version: a
 *    guessed rule is wrong while being reported as right, and the member would
 *    approve it believing Divo had read it.
 *  - **Dry-running an unsaved rule.** `POST /rules/:id/test` needs a rule that
 *    already exists. Testing before creating is the single best confidence step
 *    in this flow and it needs a route that takes a match spec instead.
 *
 * The structure that *is* real is the important claim: describing and building
 * are not two modes. Describing produces conditions; the conditions are
 * editable; editing them is the builder. There is one object, and the read-back
 * sentence under it comes from `matchClauses` — the same function that renders
 * the rule on the list and on its detail page, so what somebody approves here
 * is literally the text they will come back and read months later.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Check, Inbox, Mail, MessageSquare, Plus, ShieldAlert, Tag, TriangleAlert, X,
} from 'lucide-react'
import {
  matchClauses, useCreateMailRule, useMailboxOptions,
  type MailRuleDraft, type MailboxOption,
} from './data/use-mail-automations'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useConnections } from './data/use-connections'
import {
  filterSuggestions, suggestionsFor, useMailSuggestions, type MailSuggestion,
} from './data/use-mail-suggestions'
import { Empty, PageHeader, Panel, SkelRows } from './ui'
import type { Persona } from './fixtures'
import type { Toast } from './ui'

type ScreenProps = { persona: Persona; replay: number; toast: Toast; go: (screen: string) => void }

const STEPS = ['What to catch', 'What to do', 'Check & turn on'] as const

/* The fields that offer real correspondents, and therefore the ones whose
   presence makes the provenance line worth showing. */
const ADDRESS_FIELDS = new Set(['from', 'to', 'notFrom'])

/* ── The conditions being assembled ───────────────────
   Held in the stored shape rather than a form-shaped mirror of it, so the
   read-back can run through the same `matchClauses` the rest of the app uses
   and there is no second definition of what a rule means. */

type Draft = Record<string, unknown>

type FieldKind = 'text' | 'phrase' | 'attachment' | 'window'

type Field = {
  key: string
  label: string
  kind: FieldKind
  placeholder?: string
  /** Shown beneath the input, always — the caveat belongs with its cause. */
  caveat?: string
  negative?: boolean
}

const FIELDS: Field[] = [
  {
    key: 'from', label: 'From', kind: 'text', placeholder: 'billing@acme.com or @acme.com',
    caveat: 'A leading @ covers the domain and everything under it — @acme.com also matches receipts@mail.acme.com.',
  },
  {
    key: 'to', label: 'Addressed to', kind: 'text', placeholder: 'you@company.com',
    caveat: 'Matches To, Cc, Bcc and Delivered-To alike.',
  },
  {
    key: 'subjectContains', label: 'Subject contains', kind: 'phrase', placeholder: 'invoice',
    caveat: 'Plain text, not a pattern. Add several and any one of them counts.',
  },
  {
    key: 'bodyContains', label: 'Body contains', kind: 'phrase', placeholder: 'purchase order',
    caveat: 'Reads the message body, which means it cannot judge mail whose body retention has already taken.',
  },
  {
    key: 'hasAttachment', label: 'Attachment', kind: 'attachment',
    caveat: 'Inline images and signatures do not count as attachments.',
  },
  {
    key: 'activeWindow', label: 'Only during', kind: 'window',
    caveat: 'Judged on when the mail arrived, in the timezone you pick. An end before the start runs overnight.',
  },
  {
    key: 'notFrom', label: 'Except from', kind: 'text', negative: true, placeholder: 'noreply@acme.com',
    caveat: 'Can only narrow what the rule catches. A message whose From cannot be read fails this exclusion rather than passing it.',
  },
  {
    key: 'notSubjectContains', label: 'Except subject contains', kind: 'phrase', negative: true,
    placeholder: 'newsletter', caveat: 'Can only narrow what the rule catches.',
  },
]

/* ── Destinations ─────────────────────────────────────
   Three, matching the three the backend actually runs. Each states the one
   thing about it that a member cannot infer. */

type DestinationKind = 'email' | 'lark_chat' | 'organize'

const DESTINATIONS: Array<{
  kind: DestinationKind
  icon: typeof Mail
  title: string
  body: string
  note: string
  /** Selectable so the choice is visible, but it cannot be turned on. */
  soon?: boolean
}> = [
  {
    kind: 'email', icon: Mail,
    title: 'Forward to an address',
    body: 'The whole original message, nested unchanged — headers, body and attachments.',
    note: 'Divo never rewrites or summarises a forward. It is the mail you would have got.',
  },
  {
    /*
     * Chooseable, and not yet creatable.
     *
     * The destination itself is decided — your own DM, addressed by open id,
     * exactly as scheduled work is already delivered. Two things in the
     * delivery path still assume a group chat: `deliverLark` sends through
     * `sendToChatId`, which hardcodes `receive_id_type: 'chat_id'`, and
     * `authorizeLarkChat` grounds a chat id against rooms Divo has observed as
     * groups, so an open id comes back `unknown_chat` and is refused.
     *
     * Offering it as though it worked would create rules that are accepted and
     * then silently never deliver, which is the exact failure Mail Ops exists
     * to have stopped.
     */
    kind: 'lark_chat', icon: MessageSquare,
    title: 'Send it to me on Lark',
    body: 'Divo messages you directly. Nobody else sees it.',
    note: 'Not wired up yet — Divo can address your DM, but the delivery path still assumes a group chat.',
    soon: true,
  },
  {
    kind: 'organize', icon: Tag,
    title: 'Organise it in my Gmail',
    body: 'Label it, archive it, or mark it read. Nothing leaves your mailbox.',
    note: 'No ceiling applies — nothing is sent, so a burst is answered with a burst.',
  },
]

export function MailRuleNew({ replay }: ScreenProps) {
  const navigate = useNavigate()
  const resolution = useMailboxOptions()
  const [step, setStep] = useState(0)
  const [intent, setIntent] = useState('')
  const [draft, setDraft] = useState<Draft>({})
  const [added, setAdded] = useState<string[]>([])
  const [destination, setDestination] = useState<DestinationKind | null>(null)
  const [address, setAddress] = useState('')
  const [ceiling, setCeiling] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [archive, setArchive] = useState(false)
  const [markRead, setMarkRead] = useState(false)
  const creating = useCreateMailRule()
  void replay

  const clauses = useMemo(() => matchClauses(draft), [draft])

  // One account needs no question asked. Several is a real choice and the
  // wrong answer is invisible — two of somebody's Google accounts look alike
  // in a list and only one of them receives the mail they mean.
  const mailbox = resolution.status === 'one'
    ? resolution.option
    : resolution.status === 'choose'
      ? resolution.options.find((o) => o.connectionId === picked) ?? null
      : null

  // Above the early returns, as hooks must be. Keyed on the resolved
  // connection so choosing the other account re-reads that inbox's senders
  // rather than offering the first one's.
  const suggestions = useMailSuggestions(mailbox?.connectionId ?? null)

  const setField = (key: string, value: unknown) => {
    setDraft((prev) => {
      const next = { ...prev }
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }

  const removeField = (key: string) => {
    setAdded((prev) => prev.filter((k) => k !== key))
    setField(key, null)
  }

  /*
   * What has to be true before this can be turned on, checked here rather than
   * left to the server.
   *
   * A rule with no conditions matches every message that arrives, which is
   * almost never meant and is expensive to discover — so it is refused at the
   * button rather than created and then explained.
   */
  const organizeChosen = label.length > 0 || archive || markRead
  const canCreate = clauses.length > 0
    && destination !== null
    && (destination !== 'email' || address.trim().length > 0)
    && (destination !== 'organize' || organizeChosen)
    // Lark DM is chooseable but not yet creatable — see DESTINATIONS.
    && destination !== 'lark_chat'

  const onCreate = async () => {
    if (!mailbox || !destination) return
    const request: MailRuleDraft = {
      connectionId: mailbox.connectionId,
      name: name.trim() || suggestedName(clauses, destination, address),
      match: draft,
      destination: destination === 'email'
        ? { type: 'email', email: address.trim() }
        : {
              type: 'organize',
              ...(label.length > 0 ? { label } : {}),
              ...(archive ? { archive: true } : {}),
              ...(markRead ? { markRead: true } : {}),
            },
      ...(destination !== 'organize' && ceiling.trim().length > 0
        ? { rateLimitPerHour: Number(ceiling) }
        : {}),
    }
    const ruleId = await creating.create(request)
    // Straight to the rule itself, not back to the list: the next question is
    // always "would it have caught anything", and that lives on its page.
    if (ruleId) navigate(`/me/mail/${ruleId}`)
  }

  if (resolution.status === 'loading') return <div className="page"><SkelRows n={4} /></div>

  // Three states, three remedies — the same three the tool distinguishes. They
  // used to share one sentence, which sent somebody with a scope-limited
  // account off to connect an account they already had.
  if (resolution.status === 'none' || resolution.status === 'insufficient') {
    return <NoMailbox resolution={resolution} onBack={() => navigate('/me/mail')} />
  }

  // A choice, asked once and only when there is one to make.
  if (resolution.status === 'choose' && mailbox === null) {
    return (
      <MailboxPicker
        options={resolution.options}
        onPick={setPicked}
        onBack={() => navigate('/me/mail')}
      />
    )
  }

  if (mailbox === null) return <div className="page"><SkelRows n={4} /></div>

  return (
    <>
      <PageHeader
        eyebrow={<button type="button" className="ws-crumb-back" onClick={() => navigate('/me/mail')}>
          <ArrowLeft size={13} /> Mail
        </button>}
        title="New rule"
        description={`Watching ${mailbox.accountEmail}. Nothing is turned on until the last step.`}
        actions={resolution.status === 'choose' ? (
          /* Whoever had to choose can un-choose. Without this the only way back
             to the other account is to leave the page and start again. */
          <button type="button" className="btn" onClick={() => setPicked(null)}>
            <Inbox size={14} /> Change mailbox
          </button>
        ) : undefined}
      />

      <div className="ws-stack">
        <StepBar step={step} onPick={setStep} />

        {/* The server's own sentence, never replaced with a generic failure:
            six checks can refuse this and each has a different remedy, which is
            the only part of a refusal anybody can act on. */}
        {creating.error ? (
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div><b>The rule was not created.</b> {creating.error}</div>
          </div>
        ) : null}

        {step === 0 ? (
          <>
            <Panel
              title="Describe what you want"
              description="Say it the way you would say it to a person. You will see exactly what Divo understood before anything runs."
            >
              <div className="ws-panel-body">
                <textarea
                  className="ws-comp-box"
                  rows={3}
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  placeholder="forward anything from acme.com with an invoice attached to books@vendor-cpa.com, but skip their noreply address"
                />
                <div className="ws-mk-act">
                  {/* Deliberately inert. Compiling a sentence into conditions is
                      the model's job, and a browser-side guess would produce a
                      rule that is wrong while being presented as understood. */}
                  <button type="button" className="btn primary" disabled title="Reading a sentence back as conditions is not built yet.">
                    Read it back
                  </button>
                  <span className="ws-sub">Not wired yet — set the conditions below in the meantime.</span>
                </div>
              </div>
            </Panel>

            <Panel
              title="Conditions"
              description="Every one of these has to hold. There is no “or” between them."
            >
              <div className="ws-panel-body">
                {added.length === 0 ? (
                  <p className="ws-sub">Nothing yet — add the first condition below.</p>
                ) : (
                  <div className="ws-mk-fields">
                    {added.map((key) => {
                      const field = FIELDS.find((f) => f.key === key)!
                      return (
                        <FieldRow
                          key={key}
                          field={field}
                          value={draft[key]}
                          suggestions={suggestionsFor(key, suggestions)}
                          onChange={(value) => setField(key, value)}
                          onRemove={() => removeField(key)}
                        />
                      )
                    })}
                  </div>
                )}

                {/* Where the offered senders came from, said once. A list of
                    addresses is read as fact, so an illustrative one has to
                    admit it before somebody builds a rule on a name they have
                    never actually received mail from. */}
                {added.some((k) => ADDRESS_FIELDS.has(k)) ? (
                  <p className="ws-mk-src">
                    {suggestions.loading
                      ? 'Reading who writes to this inbox…'
                      : !suggestions.watched
                        ? 'No suggestions yet — Divo has not watched this inbox before, so it has nothing to go on. Your first rule starts that; the next one will be able to offer real senders.'
                        : suggestions.from.length === 0 && suggestions.to.length === 0
                          ? 'Divo is watching this inbox but has not seen enough mail yet to suggest anything.'
                          : `Suggestions come from mail Divo has already seen for this inbox — ${suggestions.window}.`}
                  </p>
                ) : null}

                <div className="ws-mk-add">
                  {FIELDS.filter((f) => !added.includes(f.key)).map((field) => (
                    <button
                      type="button"
                      className="ws-mk-chip"
                      data-neg={field.negative ? 'true' : undefined}
                      key={field.key}
                      onClick={() => setAdded((prev) => [...prev, field.key])}
                    >
                      <Plus size={12} /> {field.label}
                    </button>
                  ))}
                </div>
              </div>

              <ReadBack clauses={clauses} />
            </Panel>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Panel title="What should Divo do with it?">
              <div className="ws-rows">
                {DESTINATIONS.map((option) => (
                  <button
                    type="button"
                    className="ws-row auto-row"
                    key={option.kind}
                    data-picked={destination === option.kind ? 'true' : undefined}
                    onClick={() => setDestination(option.kind)}
                  >
                    <span className="ws-ic"><option.icon size={14} /></span>
                    <div className="ws-row-main">
                      <b>{option.title}</b>
                      <p>{option.body}</p>
                    </div>
                    <div className="ws-row-act">
                      {option.soon ? <span className="badge">Coming soon</span> : null}
                      {destination === option.kind ? <span className="badge b-ok"><span className="dot" />Chosen</span> : null}
                    </div>
                  </button>
                ))}
              </div>
              {destination ? (
                <div className="ws-panel-foot">
                  {DESTINATIONS.find((d) => d.kind === destination)!.note}
                </div>
              ) : null}
            </Panel>

            {destination === 'email' ? (
              <Panel title="Forward to">
                <div className="ws-panel-body">
                  <input
                    className="input"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="books@vendor-cpa.com"
                  />
                  {/* The warning that used to appear only after the rule was
                      already running. A forward out of the mailbox's own domain
                      is a standing export, and that is worth knowing before it
                      exists rather than on a review screen afterwards. */}
                  {leavesDomain(address, mailbox.accountEmail) ? (
                    <div className="ws-ceiling">
                      <ShieldAlert size={14} />
                      <div>
                        <b>This address is outside {domainOf(mailbox.accountEmail)}.</b> Every message
                        this rule matches will leave your company in full — body and attachments
                        included — for as long as the rule exists.
                      </div>
                    </div>
                  ) : null}
                  <label className="ws-mk-lim">
                    <span>At most</span>
                    <input
                      className="input"
                      value={ceiling}
                      onChange={(e) => setCeiling(e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="5"
                      inputMode="numeric"
                    />
                    <span>an hour</span>
                  </label>
                  <p className="ws-sub">
                    Optional. Over the ceiling, matching mail is <b>dropped</b> rather than held — the
                    extra messages are not delivered later.
                  </p>
                </div>
              </Panel>
            ) : null}

            {destination === 'lark_chat' ? <LarkDelivery /> : null}

            {destination === 'organize' ? (
              <Panel title="What to do with it">
                <div className="ws-panel-body ws-mk-org">
                  <label>
                    <input
                      type="checkbox"
                      checked={label.length > 0}
                      onChange={(e) => setLabel(e.target.checked ? 'Divo' : '')}
                    /> Label it
                  </label>
                  {label.length > 0 ? (
                    <input
                      className="input"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Invoices"
                    />
                  ) : null}
                  <label>
                    <input type="checkbox" checked={archive} onChange={(e) => setArchive(e.target.checked)} />
                    {' '}Archive it — remove it from the inbox
                  </label>
                  <label>
                    <input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} />
                    {' '}Mark it read
                  </label>
                </div>
              </Panel>
            ) : null}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Panel title="Name it" description="How this rule appears in your list, and how you would ask Divo to change it later.">
              <div className="ws-panel-body">
                <input
                  className="input"
                  style={{ width: '100%' }}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={suggestedName(clauses, destination, address)}
                />
              </div>
            </Panel>

            <Panel title="What you asked for">
              <div className="ws-panel-body">
                {intent.trim().length > 0
                  ? <p className="ws-quote">{intent}</p>
                  : <p className="ws-sub">You built this one by hand rather than describing it.</p>}
              </div>
            </Panel>

            <Panel title="What Divo will do">
              <ReadBack clauses={clauses} />
              <div className="ws-panel-foot">
                {destination === null
                  ? 'No destination chosen yet — go back a step.'
                  : destination === 'organize'
                    ? 'The message stays in your mailbox and is organised there.'
                    : destination === 'lark_chat'
                      ? 'The message is sent to you directly in Lark.'
                      : `The whole message is forwarded, unchanged, to ${address || 'an address you have not entered yet'}.`}
              </div>
            </Panel>

            <Panel
              title="Would it have caught anything?"
              description="Replays these conditions over mail Divo has already seen for this mailbox. Nothing is sent."
            >
              <div className="ws-panel-body">
                <button type="button" className="btn" disabled title="Testing an unsaved rule needs a route that takes conditions rather than a rule id.">
                  Check these conditions
                </button>
                <p className="ws-sub">
                  Not wired yet. The existing test endpoint replays a rule that already exists, so this
                  step needs one that takes conditions instead — and it is the step that would tell you
                  whether you described the mail you meant.
                </p>
              </div>
            </Panel>
          </>
        ) : null}

        <div className="ws-mk-nav">
          <button
            type="button"
            className="btn"
            onClick={() => (step === 0 ? navigate('/me/mail') : setStep(step - 1))}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
              Continue
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={creating.saving || !canCreate}
              title={canCreate ? undefined : blockedReason(clauses, destination, address)}
              onClick={() => { void onCreate() }}
            >
              {creating.saving ? 'Turning it on…' : 'Turn it on'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Where a Lark delivery goes: your own DM, and nowhere else.
 *
 * No chat picker, deliberately. Divo already delivers every scheduled result
 * this way — `scheduled-workflow.service` passes the member's `larkOpenId`
 * straight in as the receive id, because Lark's send API takes an open id and
 * a DM therefore needs no chat to exist first. Reusing that is both less to
 * build and the safer default: a group room is a place mail can be forwarded
 * to people who were never meant to read it, and a chat id is opaque enough
 * that a wrong one is indistinguishable from a right one until it lands.
 *
 * The one precondition is a linked Lark identity. Signing in with a password
 * mints none, so this states it rather than failing at delivery time — a rule
 * that cannot reach anybody is worse than a rule that was never created.
 */
function LarkDelivery() {
  const { session } = useAdminAuth()
  const navigate = useNavigate()
  const linked = Boolean(session?.larkLinked)

  return (
    <Panel title="Where it goes">
      <div className="ws-rows">
        <div className="ws-row">
          <span className="ws-ic">{linked ? <Check size={14} /> : <TriangleAlert size={14} />}</span>
          <div className="ws-row-main">
            <b>{linked ? 'Divo will message you in Lark' : 'Your Lark account is not linked yet'}</b>
            <p>
              {linked
                ? 'Straight to your own chat with Divo. It is not posted to any group, and nobody else can see it.'
                : 'Divo reaches you through Lark, and it cannot until your account is linked once. Signing in with a password does not link it.'}
            </p>
          </div>
          <div className="ws-row-act">
            {linked ? (
              <span className="badge b-ok"><span className="dot" />Ready</span>
            ) : (
              <button type="button" className="btn" onClick={() => navigate('/settings/connections')}>
                Link Lark
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="ws-panel-foot">
        Sending anywhere other than your own DM is not offered here. Ask Divo if you need a rule that
        posts into a group.
      </div>
    </Panel>
  )
}

/**
 * Which inbox this rule watches.
 *
 * Asked as its own page rather than a dropdown among the conditions, because
 * it is the one decision here whose wrong answer is silent: two of somebody's
 * Google accounts look identical in a select, the rule is built correctly, and
 * it simply watches mail that never arrives. Every option carries whether Divo
 * already watches it and how many rules are on it, which is usually the only
 * evidence anyone needs to pick.
 */
function MailboxPicker({
  options, onPick, onBack,
}: { options: MailboxOption[]; onPick: (id: string) => void; onBack: () => void }) {
  return (
    <>
      <PageHeader
        eyebrow={<button type="button" className="ws-crumb-back" onClick={onBack}>
          <ArrowLeft size={13} /> Mail
        </button>}
        title="Which mailbox?"
        description="You have more than one Google account connected. A rule watches exactly one of them."
      />
      <Panel title="Your connected accounts">
        <div className="ws-rows">
          {options.map((option) => (
            <button
              type="button"
              className="ws-row auto-row"
              key={option.connectionId}
              onClick={() => onPick(option.connectionId)}
            >
              <span className="ws-ic"><Mail size={14} /></span>
              <div className="ws-row-main">
                <b>{option.accountEmail}</b>
                <p>
                  {option.watched
                    ? `Divo already watches this inbox · ${option.activeRuleCount} active rule${option.activeRuleCount === 1 ? '' : 's'}`
                    : 'Not watched yet — the first rule here starts it'}
                  {option.accountName ? ` · ${option.accountName}` : ''}
                </p>
              </div>
              <div className="ws-row-act">
                {option.watched ? <span className="badge b-ok"><span className="dot" />Watching</span> : null}
              </div>
            </button>
          ))}
        </div>
        <div className="ws-panel-foot">
          Only accounts you own can be watched. One shared with you read-only can be read from, but
          not forwarded with.
        </div>
      </Panel>
    </>
  )
}

/**
 * No usable account, said two different ways.
 *
 * "Connect Google" is the wrong instruction for somebody who already has,
 * and who needs to grant Gmail access on the account they have — they would
 * connect a second one, hit the same wall, and have two.
 */
function NoMailbox({
  resolution, onBack,
}: { resolution: { status: 'none' } | { status: 'insufficient'; options: MailboxOption[] }; onBack: () => void }) {
  const { loading, connecting, connect } = useConnections()
  const [failed, setFailed] = useState<string | null>(null)
  const insufficient = resolution.status === 'insufficient'

  const onConnect = async () => {
    setFailed(null)
    try {
      // Asks Google for mail alone — six scopes, not the forty the general
      // Connected apps flow requests, because that is all this page needs.
      await connect('google_workspace', { forTools: ['mailAutomations'] })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'The connect window could not be opened.')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={<button type="button" className="ws-crumb-back" onClick={onBack}>
          <ArrowLeft size={13} /> Mail
        </button>}
        title="New rule"
      />
      <Empty
        icon={insufficient ? ShieldAlert : Inbox}
        title={insufficient
          ? 'Your Google account cannot be used for mail yet'
          : 'Connect the inbox you want watched'}
        body={insufficient
          ? `${resolution.options.map((o) => o.accountEmail).join(', ')} is connected, but shared read-only or missing Gmail access. Divo has to read, watch and send with it to run a rule. Reconnect it and grant the full Gmail access.`
          : 'A rule watches one Gmail inbox. Google will ask for your mail only — not Drive, Calendar or anything else.'}
        action={
          <button
            type="button"
            className="btn primary"
            disabled={loading || connecting === 'google_workspace'}
            onClick={() => { void onConnect() }}
          >
            {connecting === 'google_workspace'
              ? 'Waiting for Google…'
              : insufficient ? 'Reconnect Google' : 'Connect Gmail'}
          </button>
        }
      />
      {failed ? (
        <div className="ws-note">
          <TriangleAlert size={14} />
          <div>{failed}</div>
        </div>
      ) : null}
    </>
  )
}

/** The rule read back as the sentence it will be shown as everywhere else. */
function ReadBack({ clauses }: { clauses: string[] }) {
  if (clauses.length === 0) {
    return (
      <div className="ws-panel-foot">
        {/* A rule with no conditions matches everything that arrives, which is
            almost never what anybody meant and is worth saying outright. */}
        No conditions yet. As written, this would act on <b>every message</b> that arrives.
      </div>
    )
  }
  return (
    <div className="ws-readback">
      <b>When mail arrives</b> that is {clauses.join(', and ')}.
    </div>
  )
}

/**
 * A text field that offers the people who actually write to this mailbox.
 *
 * Not a `<select>`: every one of these fields accepts values the list will
 * never contain — a sender who has not written yet, a domain being onboarded
 * next week — so the typed value always wins and the list only ever helps.
 *
 * Opens on focus rather than only after a keystroke. The whole point is for
 * somebody who does not know what to type to see what there is.
 */
function SuggestInput({
  field, value, suggestions, onChange,
}: {
  field: Field
  value: string
  suggestions: MailSuggestion[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const hits = filterSuggestions(suggestions, value).slice(0, 8)

  const commit = (next: string) => {
    onChange(next)
    setOpen(false)
    setCursor(0)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || hits.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % hits.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + hits.length) % hits.length) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(hits[cursor]!.value) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div className="ws-sg">
      <input
        className="input"
        placeholder={field.placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setCursor(0) }}
        onFocus={() => setOpen(true)}
        // Deferred, or the click that picks a row unmounts the row first.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && hits.length > 0 ? (
        <div className="ws-sg-list">
          {hits.map((hit, i) => (
            <button
              type="button"
              key={`${hit.kind}:${hit.value}`}
              className="ws-sg-opt"
              data-on={i === cursor ? 'true' : undefined}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(hit.value)}
            >
              <span className="ws-sg-v">{hit.value}</span>
              <span className="ws-sg-m">
                {hit.kind === 'domain'
                  /* Said on the row that causes it. A domain suggestion is the
                     one place somebody learns the rule will be wider than the
                     literal string they just accepted. */
                  ? `${hit.messageCount} from ${hit.senderCount ?? 0} sender${hit.senderCount === 1 ? '' : 's'} · covers subdomains`
                  : hit.alias
                    ? `${hit.messageCount} messages · group address`
                    : `${hit.messageCount} messages`}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function FieldRow({
  field, value, suggestions, onChange, onRemove,
}: {
  field: Field
  value: unknown
  suggestions: MailSuggestion[]
  onChange: (value: unknown) => void
  onRemove: () => void
}) {
  return (
    <div className="ws-mk-field" data-neg={field.negative ? 'true' : undefined}>
      <div className="ws-mk-field-hd">
        <span className="ws-lbl">{field.label}</span>
        <button type="button" className="ws-mk-x" onClick={onRemove} aria-label={`Remove ${field.label}`}>
          <X size={13} />
        </button>
      </div>

      {field.kind === 'attachment' ? (
        <div className="ws-mk-seg">
          {[
            { v: true, label: 'Has one' },
            { v: false, label: 'Has none' },
          ].map((option) => (
            <button
              type="button"
              key={String(option.v)}
              data-on={value === option.v ? 'true' : undefined}
              onClick={() => onChange(value === option.v ? null : option.v)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : field.kind === 'window' ? (
        <div className="ws-mk-win">
          <input className="input" placeholder="09:00" onChange={(e) =>
            onChange({ ...(value as object ?? {}), start: e.target.value })} />
          <span>to</span>
          <input className="input" placeholder="18:00" onChange={(e) =>
            onChange({ ...(value as object ?? {}), end: e.target.value })} />
          <input className="input" placeholder="Asia/Kolkata" onChange={(e) =>
            onChange({ ...(value as object ?? {}), timeZone: e.target.value })} />
        </div>
      ) : suggestions.length > 0 ? (
        <SuggestInput
          field={field}
          value={typeof value === 'string' ? value : ''}
          suggestions={suggestions}
          onChange={onChange}
        />
      ) : (
        <input
          className="input"
          placeholder={field.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.caveat ? <p className="ws-mk-note">{field.caveat}</p> : null}
    </div>
  )
}

function StepBar({ step, onPick }: { step: number; onPick: (n: number) => void }) {
  return (
    <div className="ws-mk-steps">
      {STEPS.map((label, i) => (
        <button
          type="button"
          key={label}
          data-on={i === step ? 'true' : undefined}
          data-done={i < step ? 'true' : undefined}
          onClick={() => onPick(i)}
        >
          <i>{i + 1}</i> {label}
        </button>
      ))}
    </div>
  )
}

/**
 * A name nobody has to think of.
 *
 * Built from the rule itself, so the placeholder is already the right answer
 * for most rules and the field can simply be left alone. Naming is the last
 * thing between somebody and a working rule, and it is the least interesting.
 */
function suggestedName(
  clauses: string[],
  destination: DestinationKind | null,
  address: string,
): string {
  const first = clauses[0] ?? 'Matching mail'
  const head = first.charAt(0).toUpperCase() + first.slice(1)
  if (destination === 'organize') return `${head} — filed`
  if (destination === 'email' && address.trim().length > 0) return `${head} → ${address.trim()}`
  return head
}

/** Why the button is refusing, in the order somebody would fix them. */
function blockedReason(
  clauses: string[],
  destination: DestinationKind | null,
  address: string,
): string {
  if (clauses.length === 0) {
    return 'Add at least one condition — with none, this would act on every message that arrives.'
  }
  if (destination === null) return 'Choose what Divo should do with matching mail.'
  if (destination === 'lark_chat') return 'Sending to Lark is not wired up yet.'
  if (destination === 'email' && address.trim().length === 0) return 'Enter the address to forward to.'
  return 'Say what to do with the message: label it, archive it, or mark it read.'
}

const domainOf = (address: string): string => address.split('@')[1]?.toLowerCase() ?? ''

/** Only once there is something to compare — an empty box is not a warning. */
function leavesDomain(address: string, mailbox: string): boolean {
  const to = domainOf(address.trim())
  const own = domainOf(mailbox)
  return to.length > 0 && own.length > 0 && to !== own
}
