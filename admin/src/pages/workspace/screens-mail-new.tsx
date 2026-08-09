/**
 * The mail rule sheet — one form, three jobs, no steps.
 *
 * Creating a rule, duplicating one, and editing one are the same decisions in
 * the same order. They were going to be three screens; they are one, entered
 * three ways, because the alternative is three copies of a sentence that must
 * never disagree with each other:
 *
 *  - `/me/mail/new`               — blank
 *  - `/me/mail/new?from=<ruleId>` — seeded from an existing rule, still creates
 *  - `/me/mail/<ruleId>/edit`     — seeded, and saves back over that rule
 *
 * What differs between them is the ending, and only the ending. An edit can
 * land on top of another rule watching the same mailbox, which creating cannot
 * — so `duplicate` is an outcome only the edit path can reach, and it is shown
 * as a question ("that already exists — open it?") rather than as a failure.
 *
 * **The rule is one page, not three steps.** It was a wizard: catch → do →
 * check. Three screens for six fields, where the thing you were building was
 * never visible all at once and the proof that it worked lived a step away from
 * the conditions it was proving. Now the left column is the rule and the right
 * rail is everything that is *not* the rule — which mailbox, what it is called,
 * the hourly ceiling, and the dry run. Turn it on sits in the header and is
 * reachable from the first second.
 *
 * **Manual only, deliberately.** There is no describe-it box here. Compiling a
 * sentence into conditions is a different way in — it belongs to its own
 * surface, and having both open on one page made neither of them the answer to
 * "how do I make a rule". `useCompileMailRule` and `POST /compile` are still
 * there for when that surface exists.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Inbox, Info, Mail, Plus, ShieldAlert, Split, TriangleAlert, X,
} from 'lucide-react'
import {
  matchClauses, readAction, readDestination, useCreateMailRule, useMailAutomations,
  useMailboxOptions, usePreviewMailRule, useUpdateMailRule,
  type MailRule, type MailRuleDraft, type MailRulePreview, type MailboxOption,
} from './data/use-mail-automations'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { GmailMark, LarkMark } from './brand'
import { MailboxSetup } from './screens-mail'
import { Confirm, Empty, PageHeader, Panel, SkelRows } from './ui'
import type { Persona } from './fixtures'
import type { Toast } from './ui'

type ScreenProps = { persona: Persona; replay: number; toast: Toast; go: (screen: string) => void }

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
  /** Behind the ⓘ — worth reading once, not worth a paragraph on every row. */
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
    key: 'subjectContains', label: 'Subject has', kind: 'phrase', placeholder: 'invoice',
    caveat: 'Plain text, not a pattern. Separate several with commas — any one of them counts.',
  },
  {
    key: 'bodyContains', label: 'Body has', kind: 'phrase', placeholder: 'purchase order',
    caveat: 'Reads the message body, so it cannot judge mail whose body has aged out of storage.',
  },
  {
    key: 'hasAttachment', label: 'Attachment', kind: 'attachment',
    caveat: 'Inline images and signatures do not count as attachments.',
  },
  {
    key: 'activeWindow', label: 'Only during', kind: 'window',
    caveat: 'Judged on when the mail arrived, in the timezone you pick. An end before the start runs overnight — that is how you say “outside office hours”. Pick no days to mean every day.',
  },
  {
    key: 'notFrom', label: 'Except from', kind: 'text', negative: true, placeholder: 'noreply@acme.com',
    caveat: 'Can only narrow what the rule catches. A message whose From cannot be read fails this exclusion rather than passing it.',
  },
  {
    key: 'notSubjectContains', label: 'Except subject', kind: 'phrase', negative: true,
    placeholder: 'newsletter', caveat: 'Can only narrow what the rule catches.',
  },
]

const FIELD_KEYS = new Set(FIELDS.map((f) => f.key))

/**
 * Four endings that all used to be reported as "created".
 *
 * A rule's identity is derived from its own conditions, so building one that
 * already exists returns it, and building one that was archived brings it back.
 * Both are the right behaviour. Neither was ever said — so somebody who
 * archived a rule in March and built the same one in August landed on a "new"
 * rule already carrying five months of deliveries.
 */
const REVIVED: Record<'new' | 'active' | 'paused' | 'archived', string> = {
  new: 'Turned on. Mail arriving from now on will be acted on.',
  active: 'That rule already exists and is already running — nothing was duplicated.',
  paused: 'That rule already existed and was paused. It has been resumed, not duplicated.',
  archived: 'That rule already existed, archived. It is switched back on rather than duplicated, and it keeps its history.',
}

/**
 * The days half of an active window.
 *
 * `MailRuleActiveWindow.days` has been in the matcher and the compiler all
 * along — "only on weekdays" was a rule you could ask Divo for and could not
 * build here, and the sentence for it was already being rendered on the list.
 * Stored order is the matcher's, so a window built here reads back the way the
 * agent's does.
 */
const WEEKDAYS = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
] as const

const WEEKDAY_ORDER = WEEKDAYS.map((d) => d.key) as readonly string[]

const readDays = (window: Record<string, unknown>): string[] => {
  const raw = window['days']
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : []
}

/**
 * Toggling a day, with the two shapes that mean "any day" folded into one.
 *
 * The schema is `min(1).optional()` and the matcher reads a missing `days` as
 * every day — so an empty selection has to drop the key rather than store `[]`,
 * which would be rejected, and all seven drops it too because storing the full
 * week says the same thing in a way that then has to be maintained.
 */
function toggleDay(window: Record<string, unknown>, day: string): Record<string, unknown> {
  const current = readDays(window)
  const next = current.includes(day)
    ? current.filter((d) => d !== day)
    : [...current, day].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b))
  const { days: _drop, ...rest } = window
  return next.length === 0 || next.length === 7 ? rest : { ...rest, days: next }
}

/* ── Destinations ─────────────────────────────────────
   Three, matching the three the backend actually runs. Each states the one
   thing about it that a member cannot infer, and nothing they can. */

type DestinationKind = 'email' | 'lark_dm' | 'organize' | 'routed'

const DESTINATIONS: Array<{
  kind: DestinationKind
  /** A node, not a lucide component: two of the three are somebody's brand. */
  mark: () => JSX.Element
  title: string
  body: string
}> = [
  {
    kind: 'email', mark: () => <Mail size={15} />,
    title: 'Forward it', body: 'The whole message, unchanged.',
  },
  {
    kind: 'lark_dm', mark: () => <LarkMark size={15} />,
    title: 'Send it to me on Lark', body: 'Your own chat with Divo.',
  },
  {
    kind: 'organize', mark: () => <GmailMark size={15} />,
    title: 'File it in Gmail', body: 'Label, archive or mark read.',
  },
  {
    kind: 'routed', mark: () => <Split size={15} />,
    title: 'Sort it between people', body: 'Divo reads it and picks who gets it.',
  },
]

/** One branch of a routed rule, as the form holds it. */
type RouteRow = { when: string; email: string }

/**
 * The keys the server is given, derived rather than typed.
 *
 * A key is a label the model answers with; the member is describing kinds of
 * mail, not naming variables, so asking them for a slug would be asking for
 * something they have no opinion about. Derived from the position so it is
 * stable while a row is edited, and short enough to be an easy token.
 */
const routeKey = (index: number): string => `route-${index + 1}`

/** The runtime's cap, stated once so the button and the server agree. */
const MAX_ROUTES = 6

/* ══ Entry points ══════════════════════════════════════ */

export function MailRuleNew(props: ScreenProps) {
  const [params] = useSearchParams()
  return <MailRuleForm {...props} mode="create" sourceRuleId={params.get('from')} />
}

export function MailRuleEdit(props: ScreenProps) {
  const { ruleId } = useParams()
  return <MailRuleForm {...props} mode="edit" sourceRuleId={ruleId ?? null} />
}

/* ══ The sheet ═════════════════════════════════════════ */

function MailRuleForm({
  mode, sourceRuleId, toast,
}: ScreenProps & { mode: 'create' | 'edit'; sourceRuleId: string | null }) {
  const navigate = useNavigate()
  const resolution = useMailboxOptions()
  /* Read unconditionally — a hook cannot be skipped, and the seeded paths need
     it. A blank create pays for a list it will not use, which is one small
     request against `useMailboxOptions` having already made the same one. */
  const existing = useMailAutomations(true)
  const [draft, setDraft] = useState<Draft>({})
  /* One empty condition to start. A sheet whose first block says "nothing yet"
     is a page with nowhere to begin — this is the hand-built path, so its first
     screen should have something to type in. */
  const [added, setAdded] = useState<string[]>(['from'])
  const [destination, setDestination] = useState<DestinationKind | null>(null)
  const [address, setAddress] = useState('')
  const [ceiling, setCeiling] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [name, setName] = useState('')
  /* Whether the name is somebody's or Divo's. It follows the destination until
     somebody takes it over, so the field is never an empty box that reads as
     unfinished work while the code quietly uses a suggestion anyway. */
  const [nameEdited, setNameEdited] = useState(false)
  const [label, setLabel] = useState('')
  const [archive, setArchive] = useState(false)
  const [markRead, setMarkRead] = useState(false)
  /*
   * The AI step.
   *
   * Two pieces of state rather than one nullable object, because "the box is
   * open and empty" and "there is no step" are different things to the member
   * and only the second may reach the server. Collapsing them would mean
   * opening the box and typing nothing silently saved a rule with a question of
   * `""`, which the schema refuses and which reads to them as the form losing
   * their work.
   */
  const [judging, setJudging] = useState(false)
  const [question, setQuestion] = useState('')
  const [failOpen, setFailOpen] = useState(false)
  /*
   * The routing table.
   *
   * Two empty rows to start rather than one: a single row is a plain forward
   * with extra steps, and the shape of the thing being built is only legible
   * once there are two of them side by side.
   *
   * `otherwiseEmail` empty means hold — nothing is sent and the member sees it
   * under What Divo caught. There is no third state that drops a message
   * silently, here or in the runtime.
   */
  const [routes, setRoutes] = useState<RouteRow[]>([
    { when: '', email: '' },
    { when: '', email: '' },
  ])
  const [otherwiseEmail, setOtherwiseEmail] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [touched, setTouched] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const creating = useCreateMailRule()
  const updating = useUpdateMailRule()
  const preview = usePreviewMailRule()
  const { session } = useAdminAuth()
  // Divo reaches somebody through Lark or not at all; password sign-in mints no
  // Lark identity, so this is a real precondition rather than a formality.
  const larkLinked = Boolean(session?.larkLinked)

  const editing = mode === 'edit'
  const source = sourceRuleId
    ? existing.rules.find((r) => r.ruleId === sourceRuleId) ?? null
    : null

  /*
   * A destination this screen cannot say.
   *
   * `lark_chat` is deliberately absent from what a browser may create — a room
   * is named in conversation, and an opaque id typed one character wrong is
   * indistinguishable from a right one until the mail lands in somebody else's
   * room. But rules made through Divo in Lark do carry one, and this form
   * seeded them as *no destination at all*: every other field arrived filled
   * in, so the member picked an address to get past the empty one and saved —
   * turning a rule that announced mail in a room into one that emails it. Both
   * routes replace the whole rule, so there was nothing to stop that.
   *
   * So the screen says what it cannot do instead of quietly doing something
   * else. Changing it where it was made is a real answer; a blank field is not.
   */
  const foreignDestination = editing
    && source
    && readDestination(source.destination, source.action).kind === 'lark'

  const clauses = useMemo(() => matchClauses(draft), [draft])
  const ruleName = nameEdited ? name : suggestedName(destination, address)

  /*
   * Seeding, once.
   *
   * A duplicate and an edit start from the same place — the stored rule, read
   * back into the fields somebody would have filled in by hand. The `seeded`
   * latch matters: without it every re-render of the rules query would wipe
   * whatever the member had just typed back to the stored version.
   */
  useEffect(() => {
    if (seeded || !sourceRuleId || !source) return
    const read = seedFrom(source)
    setDraft(read.match)
    setAdded(Object.keys(read.match).filter((k) => FIELD_KEYS.has(k)))
    setDestination(read.destination)
    setAddress(read.address)
    setCeiling(read.ceiling)
    setLabel(read.label)
    setArchive(read.archive)
    setMarkRead(read.markRead)
    // Seeded like everything else, and for a sharper reason: both routes take
    // the whole rule, so a question left unseeded here would be *deleted* the
    // moment somebody edited this rule's name.
    setJudging(Boolean(source.judge))
    setQuestion(source.judge?.question ?? '')
    setFailOpen(source.judge?.onFailure === 'open')
    setRoutes(read.routes)
    setOtherwiseEmail(read.otherwiseEmail)
    // A duplicate that keeps the original's name produces two rows nobody can
    // tell apart on the list. An edit keeps it, because it is that rule.
    setName(editing ? source.name : `${source.name} (copy)`)
    setNameEdited(true)
    setPicked(source.connectionId)
    setSeeded(true)
  }, [seeded, sourceRuleId, source, editing])

  // One account needs no question asked. Several is a real choice and the
  // wrong answer is invisible — two of somebody's Google accounts look alike
  // in a list and only one of them receives the mail they mean.
  const mailbox = resolution.status === 'one'
    ? resolution.option
    : resolution.status === 'choose'
      ? resolution.options.find((o) => o.connectionId === picked) ?? null
      : null

  /* A half-built rule is real work. The browser's own prompt is the only thing
     that can catch a closed tab or a typed URL; the in-app Confirm below
     catches the two buttons that leave. */
  useEffect(() => {
    if (!touched) return
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [touched])

  const setField = (key: string, value: unknown) => {
    setTouched(true)
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
  const blocked = blockedReason({
    clauses, destination, address, larkLinked, organizeChosen, judging, question,
    routes, otherwiseEmail,
  })
  const saving = creating.saving || updating.saving
  const pending = creating.pending ?? updating.pending

  const buildDraft = (): MailRuleDraft | null => {
    if (!mailbox || !destination) return null
    return {
      connectionId: mailbox.connectionId,
      name: ruleName.trim() || suggestedName(destination, address),
      match: draft,
      destination: destination === 'email'
        ? { type: 'email', email: address.trim() }
        : destination === 'lark_dm'
          ? { type: 'lark_dm' }
          : destination === 'routed'
            ? {
                type: 'routed',
                routes: routes.map((row, index) => ({
                  key: routeKey(index),
                  when: row.when.trim(),
                  destination: { type: 'email' as const, email: row.email.trim() },
                })),
                // Absent would also mean hold on the server; sent explicitly so
                // the stored rule states what happens rather than leaving it to
                // a default somebody has to know about.
                otherwise: otherwiseEmail.trim().length > 0
                  ? { type: 'email' as const, email: otherwiseEmail.trim() }
                  : 'hold' as const,
              }
            : {
                type: 'organize',
                ...(label.length > 0 ? { label } : {}),
                ...(archive ? { archive: true } : {}),
                ...(markRead ? { markRead: true } : {}),
              },
      ...(destination !== 'organize' && ceiling.trim().length > 0
        ? { rateLimitPerHour: Number(ceiling) }
        : {}),
      ...(judging && question.trim().length > 0
        ? {
            judge: {
              question: question.trim(),
              onFailure: failOpen ? 'open' as const : 'closed' as const,
            },
          }
        : {}),
    }
  }

  const onSubmit = async () => {
    const request = buildDraft()
    if (!request) return

    if (editing && sourceRuleId) {
      const outcome = await updating.update(sourceRuleId, request)
      if (outcome.kind === 'saved') {
        setTouched(false)
        // Editing a paused rule starts it again. Saying only "Saved" to
        // somebody who paused a rule because it misbehaved, then fixed it,
        // leaves them believing their mail is still still.
        toast(outcome.resumed
          ? 'Saved — and this rule is running again, because editing a paused rule starts it. Pause it again if that is not what you wanted.'
          : 'Saved. The change applies to mail arriving from now on.')
        navigate(`/me/mail/${outcome.ruleId}`)
      }
      // `duplicate` and `pending_approval` both stay put and are rendered
      // below — neither is a failure, and neither leaves a rule to navigate to.
      return
    }

    const outcome = await creating.create(request)
    // Straight to the rule itself, not back to the list: the next question is
    // always "did it catch anything", and that lives on its page.
    //
    // A rule waiting on approval has no page to go to, deliberately: it does
    // not exist yet. Staying put is what makes that true rather than showing a
    // rule somebody could pause, rename or believe is running.
    if (outcome.kind === 'created') {
      setTouched(false)
      // What happened, before the page changes under them. Landing on a rule
      // that already carries months of deliveries, having been told it was
      // just created, reads as somebody else's rule.
      toast(REVIVED[outcome.existing ?? 'new'])
      navigate(`/me/mail/${outcome.ruleId}`)
    }
  }

  const exit = () => navigate(editing && sourceRuleId ? `/me/mail/${sourceRuleId}` : '/me/mail')
  const onExit = () => { if (touched) setLeaving(true); else exit() }

  if (resolution.status === 'loading') return <div className="page"><SkelRows n={4} /></div>

  // Four states, four remedies — the same ones the tool distinguishes, and the
  // same component the Mail page shows, so neither can drift into telling
  // somebody with a scope-limited account to connect an account they have.
  if (
    resolution.status === 'none'
    || resolution.status === 'insufficient'
    || resolution.status === 'reconnect'
  ) {
    return (
      <>
        <PageHeader
          eyebrow={<button type="button" className="ws-crumb-back" onClick={() => navigate('/me/mail')}>
            <ArrowLeft size={13} /> Mail
          </button>}
          title={editing ? 'Edit rule' : 'New rule'}
        />
        <div className="ws-stack"><MailboxSetup resolution={resolution} /></div>
      </>
    )
  }

  // Seeding a rule that has not arrived yet, or has gone.
  if (sourceRuleId && !seeded) {
    if (existing.loading) return <div className="page"><SkelRows n={4} /></div>
    if (!source) {
      return (
        <div className="page">
          <Empty
            icon={Inbox}
            title={editing ? 'No such rule to edit' : 'That rule is not there to copy'}
            body="It may have been deleted, or the link may be out of date."
            action={<button type="button" className="btn" onClick={() => navigate('/me/mail')}>All mail rules</button>}
          />
        </div>
      )
    }
  }

  // A choice, asked once and only when there is one to make. Never asked at all
  // when editing — the mailbox a rule watches is not something an edit changes.
  if (resolution.status === 'choose' && mailbox === null && !editing) {
    return (
      <MailboxPicker
        options={resolution.options}
        onPick={setPicked}
        onBack={() => navigate('/me/mail')}
      />
    )
  }

  // Checked before the form renders rather than inside it: the fields would
  // otherwise seed from a destination they cannot hold, and the first thing the
  // member does is fill the gap.
  if (foreignDestination) {
    return (
      <div className="page">
        <PageHeader
          eyebrow={<button type="button" className="ws-crumb-back" onClick={onExit}>
            <ArrowLeft size={13} /> Back to the rule
          </button>}
          title="Edit rule"
        />
        <div className="ws-empty">
          <p>This rule delivers to a Lark chat, and that is not something this screen can change.</p>
          <p className="ws-empty-sub">
            Rules that post into a room are made in Lark, where the room is named in
            conversation rather than typed as an id. Ask Divo there to change it, and
            it will edit this same rule. Everything else about it — pausing it, or
            seeing what it caught — still works here.
          </p>
        </div>
      </div>
    )
  }

  if (mailbox === null) return <div className="page"><SkelRows n={4} /></div>

  return (
    <>
      <PageHeader
        eyebrow={<button type="button" className="ws-crumb-back" onClick={onExit}>
          <ArrowLeft size={13} /> {editing ? 'Back to the rule' : 'Mail'}
        </button>}
        title={editing ? 'Edit rule' : sourceRuleId ? 'Duplicate rule' : 'New rule'}
        actions={
          <>
            {/* Why the button is refusing, beside the button. It was a `title`
                first — invisible on touch and to a keyboard — then a yellow
                panel at the foot of the page, which said the same sentence the
                conditions block was already saying and said it in alarm
                colours. It is neither: the rule is unfinished, not wrong. */}
            {blocked ? <span className="ws-mk-blocked">{blocked}</span> : null}
            {resolution.status === 'choose' && !editing ? (
              /* Whoever had to choose can un-choose. Without this the only way
                 back to the other account is to leave and start again. */
              <button type="button" className="btn" onClick={() => setPicked(null)}>
                <Inbox size={14} /> Change mailbox
              </button>
            ) : null}
            <button type="button" className="btn" onClick={onExit}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              // Nothing to press once it is with somebody else. Leaving it live
              // invites the same request again, and a member who clicks twice
              // should not have to wonder whether they sent two.
              disabled={saving || blocked !== null || pending !== null}
              onClick={() => { void onSubmit() }}
            >
              {pending
                ? `Waiting for ${pending.approverName}`
                : saving
                  ? (editing ? 'Saving…' : 'Turning it on…')
                  : (editing ? 'Save changes' : 'Turn it on')}
            </button>
          </>
        }
      />

      <div className="ws-stack">
        {/* Asked, not refused.
            Nothing the member typed is wrong and there is nothing to correct —
            a person has to answer. Rendering this as an error would send
            somebody back to rewrite a rule that was fine. */}
        {pending ? (
          <div className="ws-pending">
            <ShieldAlert size={14} />
            <div>
              <b>
                {pending.reused
                  ? `${pending.approverName} has already been asked.`
                  : `Asked ${pending.approverName} to approve this.`}
              </b>{' '}
              Forwarding to {pending.destination} sends mail outside your organisation, so it needs
              their yes. <b>{editing ? 'The change applies by itself' : 'The rule turns on by itself'}</b>{' '}
              once they agree — you do not need to come back and do this again.
            </div>
          </div>
        ) : null}

        {/* A question, not a failure. The rule this collides with may be one the
            member cannot see from here at all, which is why "archived" is said
            out loud rather than left as "that already exists". */}
        {updating.duplicate ? (
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div>
              <b>
                {updating.duplicate.archived
                  ? 'An archived rule already has these conditions.'
                  : 'Another rule already has these conditions.'}
              </b>{' '}
              {/* The server's own sentence. It used to name the colliding rule
                  in quotes — but nothing sends that name, so the panel read
                  「"another rule" watches this mailbox」. Better to say the true
                  thing without the name than to quote a placeholder. */}
              {updating.duplicate.message}
            </div>
            {updating.duplicate.ruleId ? (
              <button
                type="button"
                className="btn"
                onClick={() => navigate(`/me/mail/${updating.duplicate!.ruleId}`)}
              >
                Open that rule
              </button>
            ) : null}
          </div>
        ) : null}

        {/* The server's own sentence, never replaced with a generic failure:
            six checks can refuse this and each has a different remedy, which is
            the only part of a refusal anybody can act on. */}
        {creating.error || updating.error ? (
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div>
              <b>{editing ? 'The change was not saved.' : 'The rule was not created.'}</b>{' '}
              {creating.error ?? updating.error}
            </div>
          </div>
        ) : null}

        <div className="ws-sheet">
          <div className="ws-sheet-main">
            <section className="ws-blk">
              <div className="ws-blk-h">
                <span className="ws-blk-t">When mail arrives that is</span>
                {clauses.length > 1 ? <span className="ws-sub">all of these must hold</span> : null}
              </div>

              {added.length > 0 ? (
                <div className="ws-cond-list">
                  {added.map((key) => {
                    const field = FIELDS.find((f) => f.key === key)
                    if (!field) return null
                    return (
                      <FieldRow
                        key={key}
                        field={field}
                        value={draft[key]}
                        onChange={(value) => setField(key, value)}
                        onRemove={() => removeField(key)}
                      />
                    )
                  })}
                </div>
              ) : null}

              <div className="ws-mk-add">
                {FIELDS.filter((f) => !added.includes(f.key)).map((field) => (
                  <button
                    type="button"
                    className="ws-mk-chip"
                    data-neg={field.negative ? 'true' : undefined}
                    key={field.key}
                    onClick={() => { setAdded((prev) => [...prev, field.key]); setTouched(true) }}
                  >
                    <Plus size={12} /> {field.label}
                  </button>
                ))}
              </div>

            </section>

            {/*
              Between the conditions and the action, which is exactly where it
              runs. Putting it beside the ceiling in the right-hand rail would
              have filed it as a setting; it is a stage the mail passes through,
              and its position on the page is the clearest explanation of that
              anybody gets.
            */}
            {/*
              Hidden entirely on a routed rule, rather than disabled.

              A yes/no question and a single destination are independent — the
              question decides *whether*, the picker decides *where*. On a routed
              rule they are the same decision, so leaving this on screen would
              offer a question and, beneath it, a table that already asks one.
              The runtime refuses the pair outright, so a rule built from both
              could not be saved at all.
            */}
            <section className="ws-blk" hidden={destination === 'routed'}>
              <div className="ws-blk-h">
                <span className="ws-blk-t">Then Divo reads it</span>
                <label className="ws-mk-tog">
                  <input
                    type="checkbox"
                    checked={judging}
                    onChange={(e) => { setJudging(e.target.checked); setTouched(true) }}
                  />
                  {' '}Ask a question first
                </label>
              </div>

              {judging ? (
                <div className="ws-blk-body">
                  <textarea
                    className="input ws-mk-q"
                    rows={2}
                    value={question}
                    onChange={(e) => { setQuestion(e.target.value); setTouched(true) }}
                    placeholder="Is this a real invoice addressed to us, rather than marketing, a quote, or a reminder for something already paid?"
                  />
                  <p className="ws-mk-hint">
                    Divo answers yes or no for each matching message and only acts on a yes.
                    A no is <b>kept, not lost</b> — it appears under What Divo caught with the
                    reason. Divo sees the sender, the subject and a short preview, never
                    attachments. A question decides <i>whether</i>, never <i>who</i>.
                  </p>

                  <label className="ws-mk-tog">
                    <input
                      type="checkbox"
                      checked={failOpen}
                      onChange={(e) => { setFailOpen(e.target.checked); setTouched(true) }}
                    />
                    {' '}If Divo cannot answer, go ahead anyway
                  </label>
                  {/* Said here rather than in a tooltip, because it is the one
                      choice on this screen whose wrong answer is invisible: a
                      rule that fails open looks identical to one that is
                      working right up until the model is unreachable. */}
                  <p className="ws-mk-hint">
                    {failOpen
                      ? 'Off-days included: if Divo cannot read a message it will be acted on unread.'
                      : 'Left off, a message Divo cannot read is held back and shown to you.'}
                  </p>
                  {failOpen && destination === 'email'
                    && leavesDomain(address, mailbox.accountEmail) ? (
                    <div className="ws-ceiling">
                      <ShieldAlert size={14} />
                      <div>
                        <b>This forward leaves {domainOf(mailbox.accountEmail)}.</b> With this on,
                        mail Divo could not read is sent out of the company unread.
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="ws-blk-body">
                  <p className="ws-mk-hint">
                    Conditions match words. A question lets Divo tell a real invoice from an
                    advert that says “invoice” — worth adding when what you want is a judgement
                    rather than a pattern. To send different mail to different people instead,
                    choose <b>Sort it between people</b> below.
                  </p>
                </div>
              )}
            </section>

            <section className="ws-blk">
              <div className="ws-blk-h"><span className="ws-blk-t">Divo will</span></div>

              <div className="ws-picks">
                {DESTINATIONS.map((option) => (
                  <button
                    type="button"
                    className="ws-pick"
                    key={option.kind}
                    data-on={destination === option.kind ? 'true' : undefined}
                    onClick={() => {
                      setDestination(option.kind)
                      // A routed rule already asks its own question. Clearing it
                      // here rather than ignoring it on save, so somebody who
                      // typed one and then switched sees it go.
                      if (option.kind === 'routed') setJudging(false)
                      setTouched(true)
                    }}
                  >
                    <span className="ws-pick-i">{option.mark()}</span>
                    <b>{option.title}</b>
                    <p>{option.body}</p>
                  </button>
                ))}
              </div>

              {destination === 'email' ? (
                <div className="ws-blk-body">
                  <input
                    className="input"
                    value={address}
                    onChange={(e) => { setAddress(e.target.value); setTouched(true) }}
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
                        <b>Outside {domainOf(mailbox.accountEmail)}.</b> Matching mail leaves your
                        company in full, so your manager is asked before this starts.
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {destination === 'lark_dm' ? <LarkDelivery linked={larkLinked} /> : null}

              {destination === 'routed' ? (
                <div className="ws-blk-body">
                  <p className="ws-mk-hint">
                    Divo reads each matching message and sends it to <b>one</b> of these.
                    It can never send anywhere else. One reading per message — the same
                    cost as one question.
                  </p>

                  <div className="ws-routes">
                    <div className="ws-route ws-route-h">
                      <span>When the message is…</span>
                      <span />
                      <span>send it to</span>
                      <span />
                    </div>
                    {routes.map((row, index) => (
                      <div className="ws-route" key={index}>
                        <input
                          className="input"
                          value={row.when}
                          onChange={(e) => {
                            const next = [...routes]
                            next[index] = { ...next[index]!, when: e.target.value }
                            setRoutes(next); setTouched(true)
                          }}
                          placeholder="an invoice, bill or payment request"
                        />
                        <span className="ws-route-ar">→</span>
                        <input
                          className="input"
                          value={row.email}
                          onChange={(e) => {
                            const next = [...routes]
                            next[index] = { ...next[index]!, email: e.target.value }
                            setRoutes(next); setTouched(true)
                          }}
                          placeholder="anish@emiactech.com"
                        />
                        <button
                          type="button"
                          className="ws-route-x"
                          /* Two is the floor the runtime enforces, so the button
                             that would take it below is gone rather than
                             refusing after the click. */
                          disabled={routes.length <= 2}
                          onClick={() => {
                            setRoutes(routes.filter((_, i) => i !== index)); setTouched(true)
                          }}
                          aria-label={`Remove row ${index + 1}`}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* The count is on the button rather than behind it. Six is
                      the runtime's cap, and a button that simply stops working
                      at seven is a limit somebody discovers by failing. */}
                  <button
                    type="button"
                    className="ws-add"
                    disabled={routes.length >= MAX_ROUTES}
                    onClick={() => {
                      setRoutes([...routes, { when: '', email: '' }]); setTouched(true)
                    }}
                  >
                    <Plus size={12} /> Add another · {routes.length} of {MAX_ROUTES}
                  </button>

                  {routedExternals(routes, otherwiseEmail, mailbox.accountEmail).length > 0 ? (
                    <div className="ws-ceiling">
                      <ShieldAlert size={14} />
                      <div>
                        <b>
                          {routedExternals(routes, otherwiseEmail, mailbox.accountEmail).join(', ')}
                          {' '}
                          {routedExternals(routes, otherwiseEmail, mailbox.accountEmail).length > 1
                            ? 'are' : 'is'} outside {domainOf(mailbox.accountEmail)}.
                        </b>{' '}
                        Matching mail leaves your company in full, so your manager is asked
                        before this starts.
                      </div>
                    </div>
                  ) : null}

                  <div className="ws-route-else">
                    <span>Anything that fits none of these →</span>
                    <select
                      className="input"
                      value={otherwiseEmail.length > 0 ? 'send' : 'hold'}
                      onChange={(e) => {
                        setOtherwiseEmail(e.target.value === 'hold' ? '' : ' ')
                        setTouched(true)
                      }}
                    >
                      <option value="hold">Hold it and show me</option>
                      <option value="send">Send it to…</option>
                    </select>
                    {otherwiseEmail.length > 0 ? (
                      <input
                        className="input"
                        value={otherwiseEmail.trim()}
                        onChange={(e) => { setOtherwiseEmail(e.target.value); setTouched(true) }}
                        placeholder="everyone@emiactech.com"
                      />
                    ) : null}
                  </div>
                  <p className="ws-mk-hint">
                    Held mail is <b>kept, not lost</b> — it appears under What Divo caught with
                    the reason. Divo sees the sender, the subject and a short preview, never
                    attachments.
                  </p>
                </div>
              ) : null}

              {destination === 'organize' ? (
                <div className="ws-blk-body ws-mk-org">
                  <label>
                    <input
                      type="checkbox"
                      checked={label.length > 0}
                      onChange={(e) => { setLabel(e.target.checked ? 'Divo' : ''); setTouched(true) }}
                    /> Label it
                  </label>
                  {label.length > 0 ? (
                    <input
                      className="input"
                      value={label}
                      onChange={(e) => { setLabel(e.target.value); setTouched(true) }}
                      placeholder="Invoices"
                    />
                  ) : null}
                  <label>
                    <input type="checkbox" checked={archive} onChange={(e) => { setArchive(e.target.checked); setTouched(true) }} />
                    {' '}Archive it — remove it from the inbox
                  </label>
                  <label>
                    <input type="checkbox" checked={markRead} onChange={(e) => { setMarkRead(e.target.checked); setTouched(true) }} />
                    {' '}Mark it read
                  </label>
                </div>
              ) : null}
            </section>
          </div>

          {/* Everything that is not the rule. Which inbox, what it is called,
              the ceiling, and the proof — kept out of the rule's own column so
              the left side reads as one sentence rather than as a form. */}
          <aside className="ws-prail">
            <div className="ws-prail-s">
              <span className="ws-blk-t">Watching</span>
              <p className="ws-prail-v"><GmailMark size={14} />{mailbox.accountEmail}</p>
            </div>

            <div className="ws-prail-s">
              <span className="ws-blk-t">Name</span>
              <input
                className="input"
                value={ruleName}
                onChange={(e) => { setName(e.target.value); setNameEdited(true); setTouched(true) }}
                aria-label="Rule name"
              />
            </div>

            {destination !== null && destination !== 'organize' ? (
              <div className="ws-prail-s">
                <span className="ws-blk-t">Hourly cap</span>
                <div className="ws-prail-cap">
                  <input
                    className="input"
                    value={ceiling}
                    onChange={(e) => { setCeiling(e.target.value.replace(/[^0-9]/g, '')); setTouched(true) }}
                    placeholder="none"
                    inputMode="numeric"
                  />
                  <span className="ws-sub">an hour</span>
                </div>
                <p className="ws-cond-note">Over it, mail is dropped — not queued for later.</p>
              </div>
            ) : null}

            <div className="ws-prail-s">
              <span className="ws-blk-t">Dry run</span>
              <button
                type="button"
                className="btn"
                disabled={preview.running || clauses.length === 0}
                onClick={() => { void preview.preview(draft, mailbox.connectionId) }}
              >
                {preview.running ? 'Checking…' : preview.result ? 'Check again' : 'Check it'}
              </button>
              <p className="ws-cond-note">
                Replays these conditions over mail Divo has already seen. Nothing is sent.
              </p>
              {preview.error ? <p className="ws-proof-line">{preview.error}</p> : null}
              {preview.result ? <PreviewResult result={preview.result} /> : null}
            </div>
          </aside>
        </div>

      </div>

      {leaving ? (
        <Confirm
          title={editing ? 'Discard these changes?' : 'Discard this rule?'}
          body={editing
            ? 'The rule stays exactly as it is now. Nothing you have changed here has been saved.'
            : 'Nothing has been created — the conditions, the destination and the name are all lost.'}
          confirm="Discard"
          onConfirm={() => { setTouched(false); exit() }}
          onClose={() => setLeaving(false)}
        />
      ) : null}
    </>
  )
}

/**
 * A stored rule read back into the fields somebody would have filled in.
 *
 * Uses the same `readAction`/`readDestination` the rest of the app reads a rule
 * with, so a rule written by an older build seeds as whatever it can be read as
 * rather than blanking the form. `match` needs no translation at all — it is
 * stored in exactly the shape the builder holds.
 */
function seedFrom(rule: MailRule): {
  match: Draft
  destination: DestinationKind | null
  address: string
  ceiling: string
  label: string
  archive: boolean
  markRead: boolean
  routes: RouteRow[]
  otherwiseEmail: string
} {
  const action = readAction(rule.action)
  const to = readDestination(rule.destination, rule.action)
  const ceiling = (action.kind === 'forward' || action.kind === 'deliver') && action.rateLimitPerHour
    ? String(action.rateLimitPerHour)
    : ''

  /*
   * Seeded like everything else, and for the sharpest version of the reason
   * already written above `judge`: both routes take the whole rule, so a table
   * left unseeded here would be *deleted* the moment somebody edited this
   * rule's name — and what came back would forward everything to one place.
   */
  const routes: RouteRow[] = to.kind === 'routed'
    ? to.routes.map((route) => ({
        when: route.when,
        email: route.destination.kind === 'email' ? route.destination.email : '',
      }))
    : []

  return {
    match: { ...rule.match },
    destination: to.kind === 'email' ? 'email'
      : to.kind === 'lark_dm' ? 'lark_dm'
        : to.kind === 'routed' ? 'routed'
          : action.kind === 'organize' ? 'organize'
            : null,
    address: to.kind === 'email' ? to.email : '',
    ceiling,
    label: action.kind === 'organize' ? action.label ?? '' : '',
    archive: action.kind === 'organize' ? action.archive : false,
    markRead: action.kind === 'organize' ? action.markRead : false,
    // Two empty rows rather than none, so switching a non-routed rule to routed
    // starts from something to type in rather than an empty block.
    routes: routes.length >= 2 ? routes : [{ when: '', email: '' }, { when: '', email: '' }],
    otherwiseEmail: to.kind === 'routed' && to.otherwise?.kind === 'email'
      ? to.otherwise.email
      : '',
  }
}

/**
 * Where a Lark delivery goes: your own DM, and nowhere else.
 *
 * No chat picker, deliberately. Divo already delivers every scheduled result
 * this way — `scheduled-workflow.service` passes the member's `larkOpenId`
 * straight in as the receive id, because Lark's send API takes an open id and a
 * DM therefore needs no chat to exist first. Reusing that is both less to build
 * and the safer default: a group room is a place mail can be forwarded to
 * people who were never meant to read it.
 *
 * The one precondition is a linked Lark identity. Signing in with a password
 * mints none, so this states it rather than failing at delivery time — a rule
 * that cannot reach anybody is worse than a rule that was never created.
 */
function LarkDelivery({ linked }: { linked: boolean }) {
  const navigate = useNavigate()
  return (
    <div className="ws-blk-body">
      <div className="ws-note-row" data-warn={linked ? undefined : 'true'}>
        {linked ? <LarkMark size={15} /> : <TriangleAlert size={14} />}
        <div>
          {linked
            ? 'Straight to your own chat with Divo. Nobody else can see it.'
            : 'Your Lark account is not linked yet, and Divo reaches you through Lark or not at all.'}
        </div>
        {linked ? null : (
          <button type="button" className="btn" onClick={() => navigate('/settings/connections')}>
            Link Lark
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Which inbox this rule watches.
 *
 * Asked as its own page rather than a dropdown in the rail, because it is the
 * one decision here whose wrong answer is silent: two of somebody's Google
 * accounts look identical in a select, the rule is built correctly, and it
 * simply watches mail that never arrives.
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
              <span className="ws-ic ws-ic-brand"><GmailMark size={17} /></span>
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
 * What the replay found, in the rail, with its qualifications kept apart.
 *
 * Nothing is counted as predating here — there is no rule yet for anything to
 * predate, so the honest question is what these conditions *would* have caught
 * had they existed. Messages whose body has aged out are reported separately:
 * they are neither a match nor a miss, and folding them either way states a
 * certainty nobody has.
 */
function PreviewResult({ result }: { result: MailRulePreview }) {
  if (!result.watched) {
    return (
      <p className="ws-proof-line">
        Divo has not watched this inbox before, so there is nothing stored to check against. Your
        first rule starts the watch.
      </p>
    )
  }
  return (
    <>
      <p className="ws-proof-line">
        Read {result.consideredCount} ·{' '}
        {result.matchedCount === 0 ? 'none matched' : <b>{result.matchedCount} matched</b>}
      </p>
      {result.bodyUnavailableCount > 0 ? (
        <p className="ws-proof-line">
          {result.bodyUnavailableCount} could not be judged — their bodies have been discarded.
          Neither a match nor a miss.
        </p>
      ) : null}
      {result.matched.length > 0 ? (
        <ul className="ws-hits">
          {result.matched.slice(0, 5).map((hit) => (
            <li key={hit.eventId}>
              <Mail size={12} />
              <b>{hit.subject || 'Message without a subject'}</b>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/**
 * One condition, on one line.
 *
 * Each of these was a bordered card carrying a label, an input and a paragraph
 * of caveat — so four conditions filled a screen and the caveats, which are
 * genuinely worth reading *once*, were four paragraphs somebody scrolled past
 * every time. The caveat is now behind the ⓘ, in the one place it is about.
 */
function FieldRow({
  field, value, onChange, onRemove,
}: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
  onRemove: () => void
}) {
  const [why, setWhy] = useState(false)
  const window = (value ?? {}) as Record<string, unknown>
  const days = readDays(window)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  return (
    <div className="ws-cond" data-neg={field.negative ? 'true' : undefined}>
      <span className="ws-cond-lbl">{field.label}</span>

      <div className="ws-cond-val">
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
          /* Bound, not uncontrolled. These were write-only: seeding an existing
             rule left them looking empty while the rule carried a window, so an
             edit that touched nothing else silently dropped it. */
          <div className="ws-win">
            <div className="ws-mk-win">
              <input
                className="input" placeholder="09:00" value={str(window['start'])}
                onChange={(e) => onChange({ ...window, start: e.target.value })}
              />
              <span>to</span>
              <input
                className="input" placeholder="18:00" value={str(window['end'])}
                onChange={(e) => onChange({ ...window, end: e.target.value })}
              />
              <input
                className="input" placeholder="Asia/Kolkata" value={str(window['timeZone'])}
                onChange={(e) => onChange({ ...window, timeZone: e.target.value })}
              />
            </div>
            {/* No selection is every day, and every day is no selection — so
                neither state is a hole to fall into, and the label below says
                which one you are in rather than leaving seven grey chips to be
                read as "none of these". */}
            <div className="ws-days">
              {WEEKDAYS.map((day) => (
                <button
                  type="button"
                  key={day.key}
                  data-on={days.includes(day.key) ? 'true' : undefined}
                  aria-pressed={days.includes(day.key)}
                  onClick={() => onChange(toggleDay(window, day.key))}
                >
                  {day.label}
                </button>
              ))}
              <span className="ws-days-n">{days.length === 0 ? 'any day' : `${days.length} of 7`}</span>
            </div>
          </div>
        ) : field.kind === 'phrase' ? (
          /* A phrase field is one string or a list of them, any one of which
             counts. Typed as a comma-separated line and stored as the list, so
             a rule carrying three phrases can be corrected here rather than
             being flattened to the first one. */
          <input
            className="input"
            placeholder={field.placeholder}
            value={Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : ''}
            onChange={(e) => {
              const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
              onChange(parts.length > 1 ? parts : parts[0] ?? '')
            }}
          />
        ) : (
          <input
            className="input"
            placeholder={field.placeholder}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>

      {field.caveat ? (
        <button
          type="button"
          className="ws-cond-i"
          data-on={why ? 'true' : undefined}
          aria-label={`What “${field.label}” means`}
          aria-expanded={why}
          onClick={() => setWhy((v) => !v)}
        >
          <Info size={13} />
        </button>
      ) : <span />}

      <button type="button" className="ws-cond-x" onClick={onRemove} aria-label={`Remove ${field.label}`}>
        <X size={13} />
      </button>

      {why && field.caveat ? <p className="ws-cond-note">{field.caveat}</p> : null}
    </div>
  )
}

/**
 * A name nobody has to think of.
 *
 * Named for what the rule *does*, not for what it matches — every screen that
 * shows the name already prints the conditions directly beneath it, so a name
 * built from the first clause is the same sentence twice with the second copy
 * truncated. The destination is the one thing those lines do not already say.
 */
function suggestedName(destination: DestinationKind | null, address: string): string {
  if (destination === 'routed') return 'Sort it between people'
  if (destination === 'organize') return 'File it in Gmail'
  if (destination === 'lark_dm') return 'Send it to me on Lark'
  if (destination === 'email' && address.trim().length > 0) return `Forward to ${address.trim()}`
  return 'Mail rule'
}

/** Why the button is refusing, in the order somebody would fix them. */
function blockedReason({
  clauses, destination, address, larkLinked, organizeChosen, judging, question,
  routes, otherwiseEmail,
}: {
  clauses: string[]
  destination: DestinationKind | null
  address: string
  larkLinked: boolean
  organizeChosen: boolean
  judging: boolean
  question: string
  routes: RouteRow[]
  otherwiseEmail: string
}): string | null {
  /*
   * Refused here rather than left to the server's schema.
   *
   * An empty question is not a rule with no AI step — it is a rule the member
   * believes has one. Passing it through would either be refused as
   * `question too short`, which reads as a bug, or, if the payload dropped the
   * empty object, saved silently as a rule with no step at all: the member
   * ticked the box, watched it save, and got the indiscriminate rule.
   */
  if (judging && question.trim().length < 8) {
    return 'Write the question Divo should ask about each matching message, or turn that off.'
  }
  if (clauses.length === 0) {
    return 'Add at least one condition — with none, this would act on every message that arrives.'
  }
  if (destination === null) return 'Choose what Divo should do with matching mail.'
  if (destination === 'lark_dm' && !larkLinked) {
    return 'Link your Lark account first — Divo cannot reach you otherwise.'
  }
  if (destination === 'email' && address.trim().length === 0) return 'Enter the address to forward to.'
  if (destination === 'organize' && !organizeChosen) {
    return 'Say what to do with the message: label it, archive it, or mark it read.'
  }
  if (destination === 'routed') {
    /*
     * Refused here rather than left to the server, for the same reason the
     * empty question is. A half-filled row is a branch the member believes in;
     * sending it produces a schema error that reads as a bug, and a member
     * cannot tell which of six rows the server meant.
     */
    if (routes.length < 2) {
      return 'Add at least two kinds of message — with one, this is a plain forward.'
    }
    const half = routes.findIndex(
      (row) => (row.when.trim().length > 0) !== (row.email.trim().length > 0),
    )
    if (half >= 0) {
      return `Row ${half + 1} is half filled in — say what that kind of message is, and who gets it.`
    }
    if (routes.some((row) => row.when.trim().length < 3)) {
      return 'Describe each kind of message in a few words, so Divo can tell them apart.'
    }
    if (routes.some((row) => row.email.trim().length === 0)) {
      return 'Give every kind of message somebody to send it to.'
    }
    // Two rows described the same way is a table no answer could resolve — the
    // model would be picking between two branches that mean the same thing.
    const described = routes.map((row) => row.when.trim().toLowerCase())
    if (new Set(described).size !== described.length) {
      return 'Two rows describe the same kind of message. Divo could not tell them apart.'
    }
  }
  return null
}

const domainOf = (address: string): string => address.split('@')[1]?.toLowerCase() ?? ''

/**
 * Every branch of a routing table that leaves the company, including the one
 * for everything else.
 *
 * The fallback counts and is the branch nobody thinks about — "everything else
 * goes to X" is exactly where an unnoticed external address ends up, and it is
 * the row a member is least likely to re-read before saving.
 */
function routedExternals(
  routes: RouteRow[],
  otherwiseEmail: string,
  mailbox: string,
): string[] {
  const addresses = [...routes.map((row) => row.email), otherwiseEmail]
  return [...new Set(
    addresses
      .map((address) => address.trim())
      .filter((address) => leavesDomain(address, mailbox)),
  )]
}

/** Only once there is something to compare — an empty box is not a warning. */
function leavesDomain(address: string, mailbox: string): boolean {
  const to = domainOf(address.trim())
  const own = domainOf(mailbox)
  return to.length > 0 && own.length > 0 && to !== own
}
