/**
 * The screens.
 *
 * Ordered here the way a member meets them: sign in, connect a mailbox, make
 * one rule, watch it, read what it caught, get the brief. Every screen has a
 * first-run version and a something-is-wrong version, because those are the two
 * states a demo skips and a real user hits in week one.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowRight, Ban, Brain, CheckCircle2, ChevronRight, Clock, EyeOff, Forward,
  Inbox as InboxIcon, Loader2, Mail, MailWarning, Pause, Pencil, PenLine, Play, Plus, RefreshCw,
  Sparkles, Tag, TriangleAlert,
} from 'lucide-react'
import { GmailMark, LarkMark } from '@/pages/workspace/brand'
import { RuleBuilder } from './builder'
import { ThreadReader } from './reader'
import {
  ADMIN_ROWS, BRIEF, CADENCE, CAUGHT, ME, RULES, THREADS, type Caught, type Rule,
} from './data'
import { DivoMark, Note, Pill, SectionHead, Stat, initialsOf, inr, usePreview } from './kit'

/* ── Sign in ─────────────────────────────────────────── */
export function SignIn() {
  const nav = useNavigate()
  const { signIn, setMode } = usePreview()
  const [busy, setBusy] = useState(false)

  const go = () => {
    setBusy(true)
    window.setTimeout(() => { signIn(); setMode('first-run'); nav('/preview/mail/connect') }, 700)
  }

  return (
    <div className="mp-signin">
      <div className="mp-signin-box">
        <span className="mp-signin-mark"><DivoMark size={16} /></span>
        <h1>Divo Mail</h1>
        <p>Your mail, with the boring half done for you.</p>

        <button type="button" className="mp-lark-btn" onClick={go} disabled={busy}>
          {busy ? <Loader2 size={15} className="mp-spin" /> : <LarkMark size={16} />}
          {busy ? 'Opening Lark…' : 'Continue with Lark'}
        </button>

        <p className="mp-signin-alt">
          One sign-in. Lark says who you are — Divo never asks you for a second password, and never
          creates an account you did not already have.
        </p>
      </div>

      <div className="mp-signin-notes">
        <Note n={1} title="Lark is the only door">
          There is no email-and-password form here, and adding one later would be the mistake. Lark
          already knows who works here and which department they are in; a second credential store
          means a second place to be wrong about that.
        </Note>
        <Note n={2} title="What the member is told they are getting">
          "Mail" — that is the entire promise on this screen. Everything Divo can do sits behind
          this door, but a person joining to stop copy-pasting invoices does not need the org chart
          on day one.
        </Note>
      </div>
    </div>
  )
}

/* ── Connect a mailbox ───────────────────────────────── */
export function Connect() {
  const nav = useNavigate()
  const { connect } = usePreview()
  const [step, setStep] = useState<'ask' | 'scopes' | 'done'>('ask')

  return (
    <div className="mp-page mp-narrow">
      <div className="mp-ph">
        <h1>Connect your mailbox</h1>
        <p>Divo watches one Gmail account. Nothing happens until you make a rule.</p>
      </div>

      {step === 'ask' ? (
        <div className="mp-card mp-connect">
          <span className="mp-connect-ic"><GmailMark size={26} /></span>
          <b>{ME.email}</b>
          <p>Signed in through Lark, so this is the work account we already know about.</p>
          <button type="button" className="btn primary" onClick={() => setStep('scopes')}>Connect Gmail</button>
        </div>
      ) : null}

      {step === 'scopes' ? (
        <div className="mp-card">
          <SectionHead title="What Divo is asking for" sub="Six permissions. Not forty." />
          <ul className="mp-scopes">
            <li><CheckCircle2 size={14} /> <div><b>See mail as it arrives</b><span>So a rule can run at all.</span></div></li>
            <li><CheckCircle2 size={14} /> <div><b>Read a message you have a rule for</b><span>Only messages that match. Everything else is untouched.</span></div></li>
            <li><CheckCircle2 size={14} /> <div><b>Send on your behalf</b><span>Only forwards you set up. Divo writes no mail of its own.</span></div></li>
            <li><CheckCircle2 size={14} /> <div><b>Add and remove labels</b><span>For the "label and file it" action.</span></div></li>
          </ul>
          <div className="mp-deny">
            <Ban size={14} />
            <div>
              <b>Not asked for</b>
              <p>Your Drive, your Calendar, your contacts, or the ability to delete anything.</p>
            </div>
          </div>
          <button type="button" className="btn primary" onClick={() => { connect(); setStep('done') }}>
            Allow and continue
          </button>
          <Note n={1} title="The consent screen is a product screen">
            OAuth is where trust is won or lost, and Google's own dialog is unreadable. This restates
            it in the member's language and — more importantly — names what is *not* being asked
            for. The live integration was narrowed from forty scopes to six; this is where that work
            becomes visible.
          </Note>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="mp-card mp-connect">
          <span className="mp-connect-ic" data-ok="true"><CheckCircle2 size={26} /></span>
          <b>Connected</b>
          <p>Divo is watching {ME.email}. It will do nothing at all until you give it a rule.</p>
          <button type="button" className="btn primary" onClick={() => nav('/preview/mail/rules/new')}>
            Make your first rule <ArrowRight size={14} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ── One message ─────────────────────────────────────
   Not a screen a member navigates to. A link target, and nothing else. */
export function MessageScreen() {
  const nav = useNavigate()
  const { threadId } = useParams()
  const thread = THREADS.find((t) => t.id === threadId)

  if (!thread) {
    return (
      <div className="mp-page mp-narrow">
        <div className="mp-empty">
          <span className="ic"><Mail size={18} /></span>
          <b>This message is no longer stored</b>
          <p>
            Divo keeps message bodies for 30 days. The decision it made about this one is still in
            Caught — the text is not.
          </p>
          <button type="button" className="btn" style={{ marginTop: 14 }} onClick={() => nav('/preview/mail/caught')}>
            Back to Caught
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mp-page mp-narrow">
      <div className="mp-crumb">
        <button type="button" onClick={() => nav('/preview/mail/caught')}>Caught</button>
        <ChevronRight size={13} />
        <b>Message</b>
      </div>
      <ThreadReader thread={thread} onClose={() => nav('/preview/mail/caught')} />
    </div>
  )
}

/* ── Rules ───────────────────────────────────────────── */
const stateCopy: Record<Rule['state'], { label: string; tone: 'ok' | 'held' | 'fail' | 'blocked' | 'quiet' }> = {
  working: { label: 'Working', tone: 'ok' },
  paused: { label: 'Paused', tone: 'quiet' },
  blocked: { label: 'Blocked', tone: 'blocked' },
  broken: { label: 'Broken', tone: 'fail' },
  'over-budget': { label: 'Over its AI budget', tone: 'held' },
}

/*
 * A rule read back as one sentence, from its own stored conditions.
 *
 * Never from a server-side summary: a summary cannot express an exception, a
 * ceiling or a deadline, so a rule carrying any of them gets described here as
 * something broader than it actually is.
 */
function ruleSentence(r: Rule) {
  const m: string[] = []
  if (r.match.from) m.push(`from ${r.match.from}`)
  if (r.match.subjectContains) m.push(`subject has “${r.match.subjectContains}”`)
  if (r.match.hasAttachment) m.push('with an attachment')
  if (r.match.notFrom) m.push(`never from ${r.match.notFrom}`)
  if (r.match.window) m.push(`${r.match.window.days} ${r.match.window.start}–${r.match.window.end}`)
  const what = m.length ? m.join(', ') : 'of any kind'

  if (r.kind === 'watch') {
    return `If no mail ${what} has arrived by ${r.deadline?.by ?? 'the deadline'} → tell you on Lark, ${r.deadline?.repeats ?? ''}`.trim()
  }

  const act = r.action.type === 'forward' ? `forward to ${r.destination.value}`
    : r.action.type === 'deliver' ? `send to ${r.destination.value} on Lark`
      : r.action.type === 'draft' ? 'write a reply into your Gmail drafts'
        : `label it ${r.action.label}`
  return `Mail ${what} → ${act}`
}

export function Rules() {
  const nav = useNavigate()
  const { mode, connected } = usePreview()

  if (mode === 'first-run' && !connected) return <NeedsMailbox />

  if (mode === 'first-run') {
    return (
      <div className="mp-page mp-narrow">
        <div className="mp-ph">
          <h1>Rules</h1>
          <p>What Divo watches for, and what it does about it.</p>
        </div>
        <div className="mp-card mp-first">
          <span className="mp-connect-ic"><Sparkles size={24} /></span>
          <b>No rules yet, and that is the honest state</b>
          <p>
            Divo is connected to {ME.email} and is doing nothing with it. It will keep doing nothing
            until you tell it what to watch for.
          </p>
          <button type="button" className="btn primary" onClick={() => nav('/preview/mail/rules/new')}>
            <Plus size={14} /> Make your first rule
          </button>
          <div className="mp-starters">
            <span className="mp-starters-l">Or start from one of these</span>
            {[
              'Forward vendor invoices to the finance team',
              'Send login codes to my Lark DM',
              'Draft a reply to unhappy customers',
              'Tell me if the GST acknowledgement does not arrive',
            ].map((s) => (
              <button key={s} type="button" className="mp-starter" onClick={() => nav('/preview/mail/rules/new')}>
                {s} <ChevronRight size={13} />
              </button>
            ))}
          </div>
        </div>
        <Note n={1} title="An empty state that does not lie">
          Most products open with sample data or a checklist pretending to be progress. This says the
          true thing — connected, doing nothing — and puts the one useful action under it. The
          starters are prompts into the builder, not one-click templates, so nothing is ever created
          that the member did not watch being made.
        </Note>
      </div>
    )
  }

  const rules = mode === 'trouble'
    ? RULES.map((r, i) => (i === 0 ? { ...r, state: 'broken' as const } : r))
    : RULES

  const totals = rules.reduce((a, r) => ({
    acted: a.acted + r.acted, held: a.held + r.held, failed: a.failed + r.failed,
  }), { acted: 0, held: 0, failed: 0 })

  return (
    <div className="mp-page">
      <div className="mp-ph">
        <div>
          <h1>Rules</h1>
          <p>What Divo watches for, and what it does about it.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => nav('/preview/mail/rules/new')}>
          <Plus size={14} /> New rule
        </button>
      </div>

      {mode === 'trouble' ? <MailboxDown /> : <MailboxOk />}

      <div className="mp-stats">
        <Stat k="Acted on" v={totals.acted.toLocaleString('en-IN')} s="last 30 days" />
        <Stat k="Held back by Divo" v={totals.held.toLocaleString('en-IN')} s="the AI step said no" />
        <Stat k="Failed" v={String(totals.failed)} s="needs you" />
        <Stat k="AI spend" v={inr(214)} s="this month" />
      </div>

      <div className="mp-rules">
        {rules.map((r) => {
          const s = stateCopy[r.state]
          return (
            <button key={r.id} type="button" className="mp-rule" onClick={() => nav(`/preview/mail/rules/${r.id}`)}>
              <span className="mp-rule-ic" data-tone={s.tone}>
                {r.kind === 'watch' ? <EyeOff size={15} />
                  : r.action.type === 'forward' ? <Forward size={15} />
                    : r.action.type === 'draft' ? <PenLine size={15} />
                      : r.action.type === 'deliver' ? <LarkMark size={15} /> : <Tag size={15} />}
              </span>
              <span className="mp-rule-m">
                <b>{r.name}</b>
                <span className="mp-rule-s">{ruleSentence(r)}</span>
                <span className="mp-rule-chips">
                  {r.kind === 'watch' ? <Pill tone="quiet"><EyeOff size={11} /> Fires on absence · free</Pill> : null}
                  {r.brain ? <Pill tone="ai"><Brain size={11} /> Divo reads it</Pill> : null}
                  {r.action.type === 'draft' ? <Pill tone="ai"><PenLine size={11} /> Writes a reply, never sends</Pill> : null}
                  {r.external ? <Pill tone="held">Leaves {ME.company}</Pill> : null}
                  {r.action.rateLimitPerHour ? <Pill tone="quiet">Max {r.action.rateLimitPerHour}/hr</Pill> : null}
                </span>
              </span>
              <span className="mp-rule-r">
                <Pill tone={s.tone}>{s.label}</Pill>
                <span className="mp-rule-cnt">{r.acted} acted · {r.held} held</span>
                <span className="mp-rule-at">{r.lastAt}</span>
              </span>
            </button>
          )
        })}
      </div>

      <Note n={1} title="Two numbers, not one">
        “Acted on” alone reads as success and hides the interesting half. A rule that held back 38
        messages is either saving you 38 interruptions or quietly eating your invoices, and the only
        way to know is to see both counts on the same row and be able to open either.
      </Note>
      <Note n={2} title="Three kinds of row, deliberately">
        A rule either <b>moves</b> mail, <b>reads</b> it (judge, extract, draft), or <b>watches for
        it not to come</b>. Nothing else is a rule. Everything Divo tells you unprompted is the
        brief; everything you ask it is Lark. Keeping those three apart is what stops this becoming
        a mail client.
      </Note>
      <Note n={3} title="Paused rules stay in the list">
        Dimmed, not hidden behind a filter. Hiding them means pausing a rule makes it vanish, which
        every user reads as having deleted it.
      </Note>
    </div>
  )
}

/* ── Rule detail ─────────────────────────────────────── */
export function RuleDetail() {
  const nav = useNavigate()
  const { ruleId } = useParams()
  const { mode } = usePreview()
  const rule = RULES.find((r) => r.id === ruleId)
  if (!rule) return <div className="mp-page"><div className="mp-empty"><b>No such rule.</b></div></div>

  const rows = CAUGHT.filter((c) => c.ruleId === rule.id)
  const s = stateCopy[rule.state]

  return (
    <div className="mp-page">
      <div className="mp-crumb">
        <button type="button" onClick={() => nav('/preview/mail/rules')}>Rules</button>
        <ChevronRight size={13} />
        <b>{rule.name}</b>
      </div>

      <div className="mp-ph">
        <div>
          <h1>{rule.name}</h1>
          <p>{ruleSentence(rule)}</p>
        </div>
        <div className="mp-ph-act">
          <button type="button" className="btn" onClick={() => nav(`/preview/mail/rules/${rule.id}/edit`)}>
            <Pencil size={13} /> Edit
          </button>
          <button type="button" className="btn">
            {rule.state === 'paused' ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Pause</>}
          </button>
        </div>
      </div>

      {rule.state === 'over-budget' ? (
        <div className="mp-banner" data-tone="warn">
          <TriangleAlert size={15} />
          <div>
            <b>This rule is over its AI budget for August</b>
            <p>
              It hit {inr(rule.brain?.monthlyCeiling ?? 0)} on the 6th. Since then it has been letting
              everything through unread rather than stopping — {rule.held} messages that would have
              been sorted were passed on as-is.
            </p>
          </div>
          <button type="button" className="btn">Raise the ceiling</button>
        </div>
      ) : null}

      <div className="mp-stats">
        <Stat k="Seen" v={rule.seen.toLocaleString('en-IN')} s="matched the conditions" />
        <Stat k="Acted on" v={String(rule.acted)} />
        <Stat k="Held back" v={String(rule.held)} s={rule.brain ? 'the AI step said no' : '—'} />
        <Stat k="State" v={s.label} />
      </div>

      {rule.brain ? (
        <div className="mp-card mp-brainsum">
          <span className="mp-node-ic" data-tone="ai"><Brain size={14} /></span>
          <div>
            <b>Divo reads every match before acting</b>
            <p className="mp-quote">“{rule.brain.prompt}”</p>
            <span className="muted">
              {rule.brain.mode === 'judge' ? 'Judge' : 'Extract'} ·
              {' '}{inr(rule.brain.costPerMessage)}/message · fails {rule.brain.failure} ·
              {' '}ceiling {inr(rule.brain.monthlyCeiling)}/month
            </span>
          </div>
        </div>
      ) : null}

      <SectionHead
        title="What it acted on"
        sub="Newest first. Every row opens the message it is about."
        right={<button type="button" className="btn" onClick={() => nav('/preview/mail/caught')}>See everything Divo caught</button>}
      />
      <CaughtRows rows={rows} />

      <Note n={1} title="The detail page answers one question">
        Not "how is it configured" — the builder shows that. "Is it still doing the right thing." So
        the configuration is one summary card and the rest of the page is evidence, ordered by
        recency, each row opening the actual message.
      </Note>
    </div>
  )
}

/* ── Caught feed ─────────────────────────────────────── */
function CaughtRows({ rows }: { rows: Caught[] }) {
  const nav = useNavigate()
  return (
    <div className="mp-caught">
      {rows.map((c) => (
        <div className="mp-crow" key={c.id}>
          <div className="mp-crow-h">
            <span className="mp-av">{initialsOf(c.fromName)}</span>
            <div className="mp-crow-who">
              <b>{c.fromName}</b>
              <span>{c.fromEmail}</span>
            </div>
            <span className="mp-crow-at">{c.at}</span>
          </div>
          <div className="mp-crow-s">{c.subject}</div>
          <div className="mp-crow-p">{c.snippet}</div>
          <div className="mp-crow-f">
            <Pill tone="quiet">{c.rule}</Pill>
            {c.verdict ? (
              <Pill tone={c.verdict.tone === 'pass' ? 'ok' : c.verdict.tone === 'reject' ? 'held' : 'fail'}>
                <Brain size={11} /> {c.verdict.label}
                {c.verdict.confidence ? ` · ${Math.round(c.verdict.confidence * 100)}%` : ''}
              </Pill>
            ) : null}
            <Pill tone={c.outcome.tone}>{c.outcome.label}</Pill>
            {c.threadId ? (
              <button type="button" className="mp-linkish" onClick={() => nav(`/preview/mail/message/${c.threadId}`)}>
                Read it
              </button>
            ) : null}
          </div>
          {c.verdict ? <p className="mp-crow-why">“{c.verdict.reason}”</p> : null}
        </div>
      ))}
      {!rows.length ? <div className="mp-empty"><b>Nothing yet.</b><p>This fills as mail arrives.</p></div> : null}
    </div>
  )
}

export function CaughtFeed() {
  const { mode, connected } = usePreview()
  const [filter, setFilter] = useState('all')

  if (mode === 'first-run' && !connected) return <NeedsMailbox />

  if (mode === 'first-run') {
    return (
      <div className="mp-page mp-narrow">
        <div className="mp-ph"><h1>Caught</h1><p>Every message a rule touched.</p></div>
        <div className="mp-empty">
          <span className="ic"><InboxIcon size={18} /></span>
          <b>Nothing caught yet</b>
          <p>Your rules have not matched anything since you turned them on. This page fills itself.</p>
        </div>
      </div>
    )
  }

  const rows = CAUGHT.filter((c) => (
    filter === 'all' ? true
      : filter === 'acted' ? c.outcome.tone === 'ok'
        : filter === 'held' ? c.outcome.tone === 'held'
          : c.outcome.tone === 'fail' || c.outcome.tone === 'blocked'
  ))

  return (
    <div className="mp-page">
      <div className="mp-ph">
        <div>
          <h1>Caught</h1>
          <p>Every message a rule touched, and what Divo decided about it.</p>
        </div>
      </div>

      <div className="mp-list-f">
        {[
          { id: 'all', label: 'Everything', n: CAUGHT.length },
          { id: 'acted', label: 'Acted on', n: CAUGHT.filter((c) => c.outcome.tone === 'ok').length },
          { id: 'held', label: 'Held back by Divo', n: CAUGHT.filter((c) => c.outcome.tone === 'held').length },
          { id: 'failed', label: 'Failed', n: CAUGHT.filter((c) => c.outcome.tone === 'fail' || c.outcome.tone === 'blocked').length },
        ].map((f) => (
          <button key={f.id} type="button" className="mp-chip" data-on={f.id === filter} onClick={() => setFilter(f.id)}>
            {f.label} <span className="n">{f.n}</span>
          </button>
        ))}
      </div>

      <Note n={1} title="Ship this before the brain">
        Every row on this page can be built from data the backend already stores — the message event
        and the delivery record. It needs no model and no new capability. And an AI gate whose
        decisions nobody can see is strictly worse than no gate, so this page has to exist first or
        the brain should not ship at all.
      </Note>

      <Note n={2} title="The verdict is quoted, not summarised">
        The model's own sentence, in italics, under the row. A confidence percentage without the
        reasoning is a number nobody can argue with; the sentence is what lets a member say "that is
        wrong" and go fix the prompt.
      </Note>

      <CaughtRows rows={rows} />

      <p className="mp-retain">
        Message bodies are kept 30 days, events 90. Older rows keep the decision and lose the text —
        “Read it” stops working, and the row says so rather than 404ing.
      </p>
    </div>
  )
}

/* ── Brief ───────────────────────────────────────────── */
export function BriefScreen() {
  const nav = useNavigate()
  const { mode, connected } = usePreview()
  const [cadence, setCadence] = useState('twice')

  if (mode === 'first-run' && !connected) return <NeedsMailbox />

  return (
    <div className="mp-page">
      <div className="mp-ph">
        <div>
          <h1>Your brief</h1>
          <p>Twice a day, in Lark. What came in, what wants you, what Divo already dealt with.</p>
        </div>
      </div>

      {mode === 'first-run' ? (
        <div className="mp-banner" data-tone="info">
          <Clock size={15} />
          <div>
            <b>Your first brief is scheduled for tomorrow, 09:00</b>
            <p>You were enrolled automatically when your mailbox connected. The first one carries a line for changing this or turning it off.</p>
          </div>
        </div>
      ) : null}

      <div className="mp-brief-wrap">
        <div className="mp-brief">
          <div className="mp-brief-h">
            <span className="mp-brief-ic"><DivoMark size={12} /></span>
            <div>
              <b>Good morning, Rahul</b>
              <span>{BRIEF.sentAt} · covers {BRIEF.covers}</span>
            </div>
          </div>

          <BriefBucket title="People" sub="Somebody wrote to you personally.">
            {BRIEF.people.map((r) => (
              <button key={r.subject} type="button" className="mp-brow" onClick={() => r.threadId && nav(`/preview/mail/message/${r.threadId}`)}>
                <b>{r.fromName}</b>
                <span className="s">{r.subject}</span>
                <span className="w">{r.want}</span>
                <span className="at">{r.at}</span>
              </button>
            ))}
          </BriefBucket>

          <BriefBucket title="Waiting on you" sub="You replied, and nobody came back.">
            {BRIEF.waiting.map((r) => (
              <div key={r.subject} className="mp-brow">
                <b>{r.fromName}</b>
                <span className="s">{r.subject}</span>
                <span className="w">{r.want}</span>
                <span className="at">{r.at}</span>
              </div>
            ))}
          </BriefBucket>

          <BriefBucket title="Divo handled" sub="Your rules, since the last brief. Costs nothing to include.">
            {BRIEF.handled.map((h) => (
              <div key={h.rule} className="mp-brow mp-brow-q">
                <b>{h.rule}</b>
                <span className="w">{h.acted} acted on{h.held ? `, ${h.held} held back` : ''}</span>
              </div>
            ))}
          </BriefBucket>

          <div className="mp-brief-rest">
            {BRIEF.notifications} notifications · {BRIEF.newsletters} newsletters · nothing needing you
          </div>
        </div>

        <div className="mp-brief-side">
          <SectionHead title="When it arrives" />
          <div className="mp-cad">
            {CADENCE.map((c) => (
              <button key={c.id} type="button" className="mp-cad-o" data-on={c.id === cadence} onClick={() => setCadence(c.id)}>
                <span className="r" />
                <div>
                  <b>{c.label} {c.recommended ? <em>recommended</em> : null}</b>
                  <span>{c.detail}</span>
                </div>
              </button>
            ))}
          </div>
          <p className="mp-side-note">Weekends off. Times are {ME.timeZone}.</p>

          <Note n={1} title="Twice, not six times">
            Six a day across 200 members is 1,200 pushes — muted inside a week — and a four-hour
            window barely batches anything. 09:00 covers overnight and the weekend; 16:00 covers
            today and what is still unanswered. 16:00 rather than 18:00 on purpose: it has to land
            while there is still time to act, or it is a list of things you failed to do.
          </Note>

          <Note n={2} title="“Divo handled” lives inside the brief">
            Not as a second card. Someone with two rules does not want two notifications, and this
            bucket is free — it is a rollup of Caught, with no Gmail read and no model call.
          </Note>

          <Note n={3} title="Empty briefs are not sent">
            A quiet day produces nothing rather than a card saying "nothing". The fastest way to
            train someone to ignore a channel is to post in it when there is no news.
          </Note>
        </div>
      </div>
    </div>
  )
}

const BriefBucket = ({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) => (
  <div className="mp-bbucket">
    <div className="mp-bbucket-h"><b>{title}</b><span>{sub}</span></div>
    {children}
  </div>
)

/* ── Settings — deliberately thin ────────────────────── */
export function Settings() {
  const nav = useNavigate()
  const { signOut, mode } = usePreview()
  return (
    <div className="mp-page mp-narrow">
      <div className="mp-ph">
        <h1>Settings</h1>
        <p>There is not much here, and that is on purpose.</p>
      </div>

      <div className="mp-card">
        <SectionHead title="You" />
        <div className="mp-kv">
          <div><span>Name</span><b>{ME.name}</b></div>
          <div><span>Email</span><b>{ME.email}</b></div>
          <div><span>Department</span><b>{ME.title}</b></div>
          <div><span>Signed in with</span><b><LarkMark size={13} /> Lark</b></div>
          <div><span>Time zone</span><b>{ME.timeZone}</b></div>
        </div>
      </div>

      <div className="mp-card">
        <SectionHead title="Mailbox" />
        <div className="mp-mbrow">
          <GmailMark size={18} />
          <div>
            <b>{ME.email}</b>
            <span>{mode === 'trouble' ? 'Reconnect needed — Google revoked the watch' : 'Connected · last checked 40 seconds ago'}</span>
          </div>
          <button type="button" className="btn">{mode === 'trouble' ? 'Reconnect' : 'Disconnect'}</button>
        </div>
      </div>

      <div className="mp-card">
        <SectionHead title="Brief" />
        <div className="mp-mbrow">
          <Clock size={16} />
          <div>
            <b>Twice a day — 09:00 and 16:00, workdays</b>
            <span>Delivered to your Lark DM.</span>
          </div>
          <button type="button" className="btn" onClick={() => nav('/preview/mail/brief')}>Change</button>
        </div>
      </div>

      <button type="button" className="btn mp-signout" onClick={() => { signOut(); nav('/preview/mail/signin') }}>
        Sign out
      </button>

      <Note n={1} title="Five facts and three switches">
        A member's settings page is where a product's real scope leaks. No theme packs, no
        notification matrix, no API keys, no workspace tab — those belong to whoever administers
        Divo, and putting them here would tell the member this is a bigger thing than "mail".
      </Note>
    </div>
  )
}

/* ── Lark side by side ───────────────────────────────── */
export function LarkView() {
  return (
    <div className="mp-page">
      <div className="mp-ph">
        <h1>What lands in Lark</h1>
        <p>The same events, in the channel most members actually live in. The web UI is the evidence; Lark is the delivery — and the only place a member can ask Divo something back.</p>
      </div>

      <Note n={1} title="Parity is the rule">
        Anything the web screens can show, the Lark card must be able to say, and neither may grow a
        feature the other cannot express. The moment a Lark-only workaround exists, the two channels
        start describing different products.
      </Note>

      <div className="mp-larks">
        <div className="ws-lark">
          <div className="ws-lark-msg">
            <div className="ws-lark-av"><DivoMark size={11} /></div>
            <div className="ws-lark-body">
              <div className="ws-lark-name">Divo</div>
              <div className="ws-lark-bubble ws-lark-card">
                <div className="ws-lark-card-h"><Forward size={13} /> Forwarded an invoice</div>
                <div className="ws-lark-card-b">
                  <b>Invoice #4471 — due 14 Aug</b><br />
                  From Acme Billing · sent to finance@emiactech.com<br />
                  <span className="muted">Rule: Vendor invoices → Finance. Divo read it first and judged it a real invoice (94%).</span>
                </div>
                <div className="ws-lark-card-f"><button type="button" className="ws-lark-btn">Open the message</button></div>
              </div>
            </div>
          </div>

          <div className="ws-lark-msg">
            <div className="ws-lark-av"><DivoMark size={11} /></div>
            <div className="ws-lark-body">
              <div className="ws-lark-name">Divo</div>
              <div className="ws-lark-bubble ws-lark-card">
                <div className="ws-lark-card-h"><DivoMark size={11} /> Your morning brief · 09:00</div>
                <div className="ws-lark-card-b">
                  <b>2 people are waiting on you</b><br />
                  Meera Iyer — wants the revised cap confirmed before Friday<br />
                  Aleem Khan — needs sign-off on August payroll today<br /><br />
                  <span className="muted">Divo handled 15 · 6 notifications · 9 newsletters</span>
                </div>
                <div className="ws-lark-card-f"><button type="button" className="ws-lark-btn">Open the brief</button></div>
              </div>
            </div>
          </div>

          <div className="ws-lark-msg">
            <div className="ws-lark-av"><DivoMark size={11} /></div>
            <div className="ws-lark-body">
              <div className="ws-lark-name">Divo</div>
              <div className="ws-lark-bubble ws-lark-card">
                <div className="ws-lark-card-h"><PenLine size={13} /> A reply is waiting for you</div>
                <div className="ws-lark-card-b">
                  <b>Nikhil Bose — Order 44821 arrived damaged</b><br />
                  Divo wrote a reply and left it in your Gmail drafts. It has not been sent.<br />
                  <span className="muted">Rule: Unhappy customers → a reply, ready to send.</span>
                </div>
                <div className="ws-lark-card-f"><button type="button" className="ws-lark-btn">Open the draft in Gmail</button></div>
              </div>
            </div>
          </div>

          <div className="ws-lark-msg">
            <div className="ws-lark-av" data-who="user">RS</div>
            <div className="ws-lark-body">
              <div className="ws-lark-name">Rahul Sharma</div>
              <div className="ws-lark-bubble">did the acme invoice come in?</div>
            </div>
          </div>

          <div className="ws-lark-msg">
            <div className="ws-lark-av"><DivoMark size={11} /></div>
            <div className="ws-lark-body">
              <div className="ws-lark-name">Divo</div>
              <div className="ws-lark-bubble">
                Yes — #4471, this morning at 09:14, ₹1,84,200, due 14 August. It went to finance
                automatically. There is a second one from Vertex Cloud still unpaid from July.
              </div>
            </div>
          </div>

          <div className="ws-lark-msg">
            <div className="ws-lark-av" data-who="user">RS</div>
            <div className="ws-lark-body">
              <div className="ws-lark-name">Rahul Sharma</div>
              <div className="ws-lark-bubble">stop forwarding the ledgerly stuff</div>
            </div>
          </div>

          <div className="ws-lark-msg">
            <div className="ws-lark-av"><DivoMark size={11} /></div>
            <div className="ws-lark-body">
              <div className="ws-lark-name">Divo</div>
              <div className="ws-lark-bubble">
                Already handled — the AI step on “Vendor invoices → Finance” has held back 4 Ledgerly
                messages this month, including this morning's. Nothing from them has been forwarded.
                Want me to block the sender outright so it does not cost anything to check?
              </div>
            </div>
          </div>
        </div>

        <div className="mp-larks-side">
          <Note n={2} title="The card carries the verdict">
            A forward notification that does not say the model was involved makes the model
            invisible, and an invisible model is one nobody can correct. Every card that follows an
            AI step names it and shows the confidence.
          </Note>
          <Note n={3} title="Chat is a control surface, not just an outlet">
            "Stop forwarding the ledgerly stuff" is a rule edit expressed the way a person actually
            says it. Divo answers with what is already true before offering to change anything — the
            member's premise was wrong, and saying so is more useful than obeying.
          </Note>
          <Note n={4} title="Asking is the third axis, and it only exists here">
            Rules run without you. The brief talks at you. <b>“Did the Acme invoice come in?”</b> is
            the only place you talk back, and it needs no new capability — Divo can already search
            Gmail. It is also the cheapest thing on this page and the only part that feels like a
            person rather than a settings screen, which is why it stays in Lark and never becomes a
            search box in the web UI.
          </Note>
          <Note n={5} title="Approval prompts land here too">
            An external forward needs an admin's yes. That prompt goes to the admin's Lark, not to an
            email they will not read, and the audit row is written when they tap it.
          </Note>
        </div>
      </div>
    </div>
  )
}

/* ── Behind the packaging: the admin view ────────────── */
export function AdminView() {
  return (
    <div className="mp-page">
      <div className="mp-ph">
        <div>
          <h1>Behind the packaging</h1>
          <p>What a company admin sees. Members never reach this screen, and nothing in their shell hints it exists.</p>
        </div>
      </div>

      <Note n={1} title="Why it is in the prototype at all">
        The member-facing product is deliberately small. It is only defensible if somebody can answer
        "who is forwarding what, to where, at what cost" — so this screen is the price of the
        packaging, not an extra.
      </Note>

      <div className="mp-stats">
        <Stat k="Members with mail on" v="14 of 22" />
        <Stat k="Rules running" v="41" />
        <Stat k="Leaving the company" v="3" s="each approved" />
        <Stat k="AI spend" v={inr(4_820)} s="August, all members" />
      </div>

      <SectionHead title="Per member" sub="Sorted by spend. Anything leaving the company is flagged whatever it costs." />
      <table className="mp-table">
        <thead>
          <tr>
            <th>Member</th><th>Department</th><th className="n">Rules</th>
            <th className="n">With AI</th><th className="n">External</th><th className="n">Spend</th><th />
          </tr>
        </thead>
        <tbody>
          {ADMIN_ROWS.map((r) => (
            <tr key={r.name} data-state={r.state}>
              <td><span className="mp-av sm">{initialsOf(r.name)}</span> {r.name}</td>
              <td className="muted">{r.dept}</td>
              <td className="n">{r.rules || '—'}</td>
              <td className="n">{r.aiRules || '—'}</td>
              <td className="n">{r.external ? <Pill tone="held">{r.external}</Pill> : '—'}</td>
              <td className="n">{r.spend ? inr(r.spend) : '—'}</td>
              <td className="n">{r.state === 'watch' ? <Pill tone="held">Review</Pill> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Note n={2} title="External forwards are the only hard gate">
        Everything else here is observation. A rule whose destination is outside the company cannot
        send its first message until an admin approves it, and widening the destination later
        re-triggers the approval. That single constraint is what makes the rest of it safe to leave
        to members.
      </Note>
    </div>
  )
}

/* ── Shared states ───────────────────────────────────── */
function NeedsMailbox() {
  const nav = useNavigate()
  return (
    <div className="mp-page mp-narrow">
      <div className="mp-empty">
        <span className="ic"><GmailMark size={20} /></span>
        <b>No mailbox connected</b>
        <p>Divo has nothing to watch yet. Connecting takes one screen and can be undone from Settings.</p>
        <button type="button" className="btn primary" style={{ marginTop: 14 }} onClick={() => nav('/preview/mail/connect')}>
          Connect Gmail
        </button>
      </div>
    </div>
  )
}

const MailboxOk = () => (
  <div className="mp-mailbar">
    <GmailMark size={14} />
    <span>{ME.email} · watching · last checked 40 seconds ago</span>
  </div>
)

const MailboxDown = () => (
  <div className="mp-banner" data-tone="err">
    <MailWarning size={15} />
    <div>
      <b>Divo cannot see your mailbox</b>
      <p>
        Google stopped the watch on {ME.email} about 6 hours ago — usually a password change or a
        revoked app. <b>Every rule below is stopped</b>, and mail that arrived in the meantime will
        not be caught up retroactively.
      </p>
    </div>
    <button type="button" className="btn primary"><RefreshCw size={13} /> Reconnect</button>
  </div>
)

/* ── Builder routes ──────────────────────────────────── */
export function NewRule() {
  const nav = useNavigate()
  return (
    <div className="mp-page mp-full">
      <div className="mp-crumb">
        <button type="button" onClick={() => nav('/preview/mail/rules')}>Rules</button>
        <ChevronRight size={13} />
        <b>New rule</b>
      </div>
      <RuleBuilder onCancel={() => nav('/preview/mail/rules')} onSave={() => nav('/preview/mail/rules')} />
    </div>
  )
}

export function EditRule() {
  const nav = useNavigate()
  const { ruleId } = useParams()
  const rule = RULES.find((r) => r.id === ruleId)
  return (
    <div className="mp-page mp-full">
      <div className="mp-crumb">
        <button type="button" onClick={() => nav('/preview/mail/rules')}>Rules</button>
        <ChevronRight size={13} />
        <button type="button" onClick={() => nav(`/preview/mail/rules/${ruleId}`)}>{rule?.name ?? 'Rule'}</button>
        <ChevronRight size={13} />
        <b>Edit</b>
      </div>
      <RuleBuilder
        editing
        initial={rule ? {
          kind: rule.kind, name: rule.name, match: rule.match, deadline: rule.deadline,
          brain: rule.brain, action: rule.action, destination: rule.destination,
        } : undefined}
        onCancel={() => nav(`/preview/mail/rules/${ruleId}`)}
        onSave={() => nav(`/preview/mail/rules/${ruleId}`)}
      />
    </div>
  )
}
