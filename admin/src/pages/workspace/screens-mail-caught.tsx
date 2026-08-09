/**
 * Caught — every message a rule of yours acted on, or decided not to.
 *
 * The rules page answers *are my rules working*. This answers the question that
 * actually brings somebody back: **what has Divo been doing with my mail**. Until
 * this existed that cost one click per rule, and could not be asked at all about
 * a rule the member had forgotten they made.
 *
 * The rows that matter most are the ones where nothing happened. A rule with an
 * AI step spends most of its life deciding *not* to forward, and without this
 * page that decision is invisible — the member sees a rule reporting "Working"
 * and an inbox where nothing arrived, and cannot tell "it read them and said no"
 * apart from "it is broken". So a held message is a first-class row here, with
 * the model's own sentence attached, and it is never toned as a failure.
 *
 * Grouped by day and nothing finer. A timestamp per row and a heading per day is
 * how mail is read everywhere else; inventing a second grouping (by rule, by
 * outcome) would make the reader learn this page before they can use it.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ban, Check, CircleSlash, Clock, Inbox, TriangleAlert } from 'lucide-react'
import {
  readAction, readDestination, useCaught,
  type MailCaught, type MailJudgeVerdict,
} from './data/use-mail-automations'
import { Empty, Fade, PageHeader, SkelRows, useStaged } from './ui'

/** Whether a day heading should read "Today", "Yesterday", or a date. */
function dayLabel(iso: string): string {
  const at = new Date(iso)
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(new Date()) - midnight(at)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

type Outcome = { text: string; tone: 'ok' | 'held' | 'fail' | 'busy' }

/**
 * What happened to one message, in the member's words.
 *
 * Built from the stored status rather than from the verdict, because the two
 * can disagree: a rule that fails open forwards a message its AI step could not
 * read, and saying "could not judge" as the *outcome* would report a message
 * that is sitting in the destination inbox as one that never went.
 */
function outcomeOf(row: MailCaught): Outcome {
  /*
   * The resolved address wins where there is one.
   *
   * `row.destination` is the *rule's* destination, and on a rule that sorts
   * mail between people that is a table rather than a place — so reading it
   * here would name whichever branch the summary happened to describe, about a
   * message that went to a different one.
   */
  const destination = row.resolvedDestination
    ? readDestination(row.resolvedDestination, row.action)
    : readDestination(row.destination, row.action)
  const action = readAction(row.action)

  switch (row.status) {
    case 'delivered':
      if (action.kind === 'organize') return { text: destination.label, tone: 'ok' }
      return {
        text: destination.kind === 'email'
          ? `Forwarded to ${destination.label}`
          : `Sent to ${destination.label}`,
        tone: 'ok',
      }
    case 'held':
      return { text: 'Held back — nothing was sent', tone: 'held' }
    case 'blocked':
      // The server writes the specific reason — over the ceiling, or refused by
      // permission — and it is a better sentence than any label chosen here.
      return { text: row.lastError ?? 'Not sent', tone: 'held' }
    case 'abandoned':
      return { text: row.lastError ?? 'Divo gave up on this one', tone: 'fail' }
    case 'pending':
    case 'sending':
      return { text: 'Working on it', tone: 'busy' }
    default:
      return { text: row.status, tone: 'busy' }
  }
}

const OUTCOME_ICON = {
  ok: Check,
  held: CircleSlash,
  fail: TriangleAlert,
  busy: Clock,
} as const

/**
 * The AI step's own words.
 *
 * Always the reason, never just the label. "Rejected" on its own invites the
 * member to distrust the rule; "a webinar promotion — no invoice number, no
 * amount, and an unsubscribe link" lets them agree with it or go and change the
 * question they asked.
 */
function Verdict({ verdict }: { verdict: MailJudgeVerdict }) {
  /*
   * A routed verdict reads as a sorting, not as a pass.
   *
   * "Divo passed it" about a message whose entire outcome was *which colleague
   * received it* answers a question nobody asked. `none` is a real answer —
   * the model is told to prefer it over guessing — so it is said in those
   * words rather than as a failure.
   */
  const routedNowhere = verdict.decision === 'routed'
    && (!verdict.route || verdict.route === 'none')
  const tone = verdict.decision === 'passed'
    ? 'b-ok'
    : verdict.decision === 'routed'
      ? (routedNowhere ? '' : 'b-ok')
      : verdict.decision === 'rejected' ? '' : 'b-warn'
  const label = verdict.decision === 'passed'
    ? 'Divo passed it'
    : verdict.decision === 'routed'
      ? (routedNowhere
          ? 'Divo found no match for it'
          : `Divo sorted it as ${verdict.route}`)
      : verdict.decision === 'rejected'
        ? 'Divo held it'
        : 'Divo could not read it'

  return (
    <div className="ws-caught-v">
      <span className={`badge ${tone}`}>
        {verdict.decision === 'passed' || tone === 'b-ok' ? <span className="dot" /> : null}
        {label}
        {typeof verdict.confidence === 'number'
          // Rounded to whole percent. Two decimal places on a number a model
          // made up is precision theatre.
          ? ` · ${Math.round(verdict.confidence * 100)}%`
          : null}
      </span>
      <p>{verdict.reason}</p>
    </div>
  )
}

function CaughtRow({ row, onOpenRule }: { row: MailCaught; onOpenRule: () => void }) {
  const outcome = outcomeOf(row)
  const Icon = OUTCOME_ICON[outcome.tone]

  return (
    <div className="ws-caught" data-tone={outcome.tone}>
      <div className="ws-caught-hd">
        <span className="ws-caught-t">{timeLabel(row.firstAttemptAt)}</span>
        <div className="ws-caught-m">
          <b>{row.subject ?? '(no subject)'}</b>
          {/* The sender is what makes a row identifiable when six messages share
              a subject line, which on invoices and verification codes is most
              of them. */}
          <span>{row.from ?? 'Unknown sender'}</span>
        </div>
        <button type="button" className="ws-caught-r" onClick={onOpenRule}>
          {row.ruleName}
        </button>
      </div>

      {row.verdict ? <Verdict verdict={row.verdict} /> : null}

      <div className="ws-caught-o">
        <Icon size={13} />
        <span>{outcome.text}</span>
        {/* Said out loud rather than left as a silent single attempt. A member
            who sees "sent" has no reason to imagine it took four goes. */}
        {row.attempts > 1 && row.status === 'delivered'
          ? <em>after {row.attempts} attempts</em>
          : null}
      </div>
    </div>
  )
}

export function MailCaught() {
  const [r1] = useStaged([320], 1)
  const { caught, loading, error } = useCaught()
  const navigate = useNavigate()

  const days = useMemo(() => {
    const groups = new Map<string, MailCaught[]>()
    for (const row of caught) {
      const key = dayLabel(row.firstAttemptAt)
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }
    // Insertion order is the server's order, which is newest first — so the day
    // groups come out newest first too without a second sort to disagree with.
    return [...groups.entries()]
  }, [caught])

  return (
    <div className="page">
      <PageHeader
        title="Caught"
        description="Mail your rules acted on, and mail they read and decided to leave alone."
      />

      {loading || !r1 ? <SkelRows n={4} icon /> : error ? (
        <Empty title="This could not be read" body={error} />
      ) : caught.length === 0 ? (
        <Empty
          title="Nothing yet"
          // Deliberately not "your rules are not working". An empty feed on a
          // healthy mailbox usually means no matching mail has arrived, and the
          // rules page is where a genuine fault is already stated.
          body="When a rule matches a message, what Divo did about it shows up here."
        />
      ) : (
        <Fade>
          {days.map(([day, rows]) => (
            <div className="ws-caught-day" key={day}>
              <div className="ws-caught-dh">
                <Inbox size={13} />
                <b>{day}</b>
                <span>{rows.length}</span>
              </div>
              {rows.map((row) => (
                <CaughtRow
                  key={row.deliveryId}
                  row={row}
                  onOpenRule={() => navigate(`/me/mail/${row.ruleId}`)}
                />
              ))}
            </div>
          ))}
          {caught.length >= 50 ? (
            <div className="ws-caught-more">
              <Ban size={12} />
              Showing the most recent 50. Older activity is on each rule’s own page.
            </div>
          ) : null}
        </Fade>
      )}
    </div>
  )
}
