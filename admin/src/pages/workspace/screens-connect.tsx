/**
 * The Lark → browser connect handoff.
 *
 * Today: a member is blocked mid-request in Lark, Divo posts a Connect card,
 * they authorise with Google, and the callback dead-ends on a bare HTML page
 * that says "close this tab". The work silently resumes back in Lark with no
 * acknowledgement anywhere the person is currently looking.
 *
 * The change: redirect the callback to a real landing page. Almost everything
 * needed already exists — `ConnectionAuthorizationIntent` stores the Lark
 * chat, the original message and the original request text, and the callback
 * already resolves five distinct outcomes and already enqueues the agent
 * continuation on success (google-connection.routes.ts). Only the terminal
 * `res.send(html)` needs to become a `res.redirect(302, …)`.
 *
 * Two constraints this design has to respect:
 *   1. The tab Lark opens has NO dashboard session, so the landing page must
 *      render standalone — no shell, no nav, nothing that assumes auth.
 *   2. It must carry no secrets in the URL. Outcome plus the intent id is
 *      enough; the page re-reads state server-side from the intent.
 */
import { useState } from 'react'
import {
  ArrowRight, Ban, Check, Clock, ExternalLink, Loader, MessageSquare, ShieldCheck, TriangleAlert,
} from 'lucide-react'
import { DataNote, PageHeader, Panel, Seg } from './ui'

/** Mirrors the callback's own switch — these five already exist in the backend. */
type Outcome = 'connected' | 'already_consumed' | 'denied' | 'expired' | 'invalid'

type Props = { replay: number; toast: (m: string) => void; go: (s: string) => void }

const ORIGINAL_REQUEST = 'Summarise the invoices I have not paid yet and draft a reminder to each supplier'

export function ConnectFlow({ toast }: Props) {
  const [outcome, setOutcome] = useState<Outcome>('connected')

  return (
    <>
      <PageHeader
        eyebrow="Flow spec"
        title="Connecting from a Lark chat"
        description="What a member sees when Divo needs an account it does not have yet. The handoff spans two apps, which is why it is specified as one flow rather than two screens."
      />

      <div className="filters">
        <Seg
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'connected', label: 'Success' },
            { value: 'denied', label: 'Cancelled' },
            { value: 'expired', label: 'Expired' },
            { value: 'already_consumed', label: 'Already done' },
          ]}
        />
        <span className="ws-sub">Every state below is one the backend already returns</span>
      </div>

      <div className="ws-stack">
        <div className="ws-flow">
          <div>
            <div className="ws-stage-lbl"><i>1</i> In Lark</div>
            <LarkPane />
          </div>
          <ArrowRight size={18} className="ws-flow-arrow" />
          <div>
            <div className="ws-stage-lbl"><i>2</i> Browser, after Google</div>
            <Landing outcome={outcome} toast={toast} />
          </div>
        </div>

        <Panel title="What changes" description="Everything except the last line already exists">
          <div className="ws-rows">
            <Row
              n="1"
              title="Divo posts the Connect card in Lark"
              body="Already built. The card is sent when a tool is blocked by a missing connection, and the whole request is stored against a ConnectionAuthorizationIntent so it can be resumed."
              state="live"
            />
            <Row
              n="2"
              title="Google returns to /api/google/connection/callback"
              body="Already built. Resolves connected · already_consumed · denied · expired · invalid, and on success enqueues the agent continuation so the original request resumes on its own."
              state="live"
            />
            <Row
              n="3"
              title="The callback redirects to the dashboard instead of dead-ending"
              body="The change. Replace res.send(resultHtml(…)) with res.redirect(302, `${WEB_URL}/connected?outcome=…&intent=…`). The five outcomes map one-to-one onto the five states above."
              state="small"
            />
            <Row
              n="4"
              title="The landing page reads the intent and shows what happens next"
              body="Needs a small unauthenticated read: given an intent id, return the outcome, the account connected, the original request text and a deep link back to the Lark thread. No tokens, no scopes, no session."
              state="new"
            />
          </div>
          <div className="ws-panel-foot">
            <ShieldCheck size={13} />
            The landing page must work with no dashboard session — the tab Lark opens is not signed in.
          </div>
        </Panel>

        <Panel title="Why bother" description="The case for the redirect">
          <div className="ws-panel-body">
            <p className="ws-sentence">
              Right now the member ends up on a blank page telling them to close the tab, while the thing they
              actually asked for finishes somewhere they are no longer looking.
            </p>
            <p className="ws-sentence-note">
              The redirect turns the dead end into the one moment the member is most likely to explore the
              dashboard — they are already in a browser, already authenticated with the provider, and have just
              been reminded that Divo exists. It is also the only natural place to tell them what they just
              agreed to, which no part of the Lark flow currently does.
            </p>
          </div>
        </Panel>
      </div>
    </>
  )
}

function Row({ n, title, body, state }: { n: string; title: string; body: string; state: 'live' | 'small' | 'new' }) {
  return (
    <div className="ws-row" style={{ alignItems: 'flex-start' }}>
      <span className="ws-ic" data-tone={state === 'live' ? 'ok' : state === 'new' ? 'warn' : undefined}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{n}</span>
      </span>
      <div className="ws-row-main">
        <b>
          {title}
          {state === 'live' ? <span className="badge b-ok"><span className="dot" />Exists</span> : null}
          {state === 'small' ? <span className="ws-tag">Few lines</span> : null}
          {state === 'new' ? <span className="ws-note" data-kind="new">New endpoint</span> : null}
        </b>
        <p>{body}</p>
      </div>
    </div>
  )
}

/** The Lark side. Styled as a foreign app on purpose — matching the Cursor
 *  language here would misrepresent which product the member is looking at. */
function LarkPane() {
  return (
    <div className="ws-lark">
      <div className="ws-lark-msg">
        <span className="ws-lark-av" data-who="user">AM</span>
        <div className="ws-lark-body">
          <div className="ws-lark-name">Ananya</div>
          <div className="ws-lark-bubble">{ORIGINAL_REQUEST}</div>
        </div>
      </div>

      <div className="ws-lark-msg">
        <span className="ws-lark-av">D</span>
        <div className="ws-lark-body">
          <div className="ws-lark-name">Divo</div>
          <div className="ws-lark-bubble ws-lark-card">
            <div className="ws-lark-card-h"><ShieldCheck size={13} />Connect Google to continue</div>
            <div className="ws-lark-card-b">
              I need access to your mail to read the invoices and draft the replies. This takes about ten seconds
              and you can disconnect it at any time.
            </div>
            <div className="ws-lark-card-f">
              <button type="button" className="ws-lark-btn"><ExternalLink size={13} />Connect Google</button>
            </div>
          </div>
          <div className="ws-sub" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={11} />Link expires in 10 minutes
          </div>
        </div>
      </div>
    </div>
  )
}

const COPY: Record<Outcome, {
  tone: 'ok' | 'err' | 'warn'
  icon: typeof Check
  title: string
  body: string
  resume?: boolean
  primary: string
  secondary?: string
}> = {
  connected: {
    tone: 'ok', icon: Check,
    title: 'Google connected',
    body: 'Connected as ananya@acme.co. Divo has already picked your request back up in Lark.',
    resume: true,
    primary: 'Back to Lark',
    secondary: 'Review what Divo can see',
  },
  already_consumed: {
    tone: 'ok', icon: Check,
    title: 'Already connected',
    body: 'This link was used once already, so nothing changed. Your Google account is connected and working.',
    primary: 'Back to Lark',
    secondary: 'See your connections',
  },
  denied: {
    tone: 'warn', icon: Ban,
    title: 'You cancelled',
    body: 'Nothing was connected and Divo has not continued your request. You can start again whenever you like.',
    primary: 'Back to Lark',
    secondary: 'Connect from here instead',
  },
  expired: {
    tone: 'warn', icon: Clock,
    title: 'That link expired',
    body: 'Connect links last ten minutes for safety. Ask Divo again in Lark, or connect from the dashboard now.',
    primary: 'Connect from here instead',
    secondary: 'Back to Lark',
  },
  invalid: {
    tone: 'err', icon: TriangleAlert,
    title: 'That link is not valid',
    body: 'It may have been altered or already replaced by a newer one. Ask Divo to send a fresh link.',
    primary: 'Back to Lark',
  },
}

function Landing({ outcome, toast }: { outcome: Outcome; toast: (m: string) => void }) {
  const c = COPY[outcome]
  const Icon = c.icon
  return (
    <div className="ws-land">
      <div className="ws-land-ic" data-tone={c.tone === 'ok' ? undefined : c.tone}><Icon size={20} /></div>
      <h2>{c.title}</h2>
      <p>{c.body}</p>

      {c.resume ? (
        <div className="ws-land-resume">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--cur-muted)' }}>
            <Loader size={12} />Picking up where you left off
          </div>
          <div className="ws-land-quote">{ORIGINAL_REQUEST}</div>
        </div>
      ) : null}

      <div className="ws-land-acts">
        <button type="button" className="btn primary" onClick={() => toast('Deep link back to the Lark thread')}>
          <MessageSquare size={14} />{c.primary}
        </button>
        {c.secondary ? (
          <button type="button" className="btn" onClick={() => toast(c.secondary!)}>{c.secondary}</button>
        ) : null}
      </div>

      {outcome === 'connected' ? (
        <p className="ws-sub" style={{ marginTop: 18, lineHeight: 1.5 }}>
          Divo can now read and send mail, and read your files. You can withdraw this at any time.
        </p>
      ) : null}
    </div>
  )
}
