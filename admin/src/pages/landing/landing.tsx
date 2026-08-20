/**
 * `/` for somebody who is not signed in.
 *
 * The same composer that Home has, in the middle of an otherwise empty page,
 * and nothing else that needs a session to draw. No rail, no recent chats, no
 * dashboard, no app tray read off connections that do not exist yet.
 *
 * Why this page exists at all: `/` used to bounce a signed-out visitor straight
 * to `/login`, so the first thing Divo ever showed anybody was a password
 * field. A product whose entire proposition is "ask it in words" opening on a
 * form is the proposition being contradicted by its own front door.
 *
 * Sending here does not start a run — there is no account to run it under. It
 * keeps the sentence and opens onboarding over the top, and once that finishes
 * the sentence is the first thing Divo answers. `/login` is untouched and is
 * still where people with an account go.
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Diamond, Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/use-theme'
import { Composer } from '@/pages/workspace/chat/composer'
import { stageHandoff } from '@/pages/workspace/chat/handoff'
import { newThreadId } from '@/pages/workspace/chat/threads'
import { Onboarding } from './onboarding'
import '@/styles/beautiful.css'
import './landing.css'

const NO_MODELS = [] as const

export function Landing() {
  const { resolved, setTheme } = useTheme()
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)

  const submit = (): void => {
    if (!draft.trim()) return
    setAsking(true)
  }

  /* Signed in, seconds ago, with the sentence still in hand. Straight to a
     thread rather than back to this page: they typed it before they had an
     account and the point of the whole flow is that it still runs. */
  const run = (): void => {
    stageHandoff(draft.trim())
    navigate(`/chat/${newThreadId()}`, { replace: true })
  }

  return (
    <div className="cur lp">
      <header className="lp-top">
        <div className="brand">
          <span className="mark"><Diamond size={13} fill="currentColor" strokeWidth={0} /></span>
          <b className="display">Divo</b>
        </div>
        <div className="lp-top-right">
          <button
            type="button"
            className="lp-icon-btn"
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
            aria-label={resolved === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <Link className="lp-signin" to="/login">Sign in</Link>
        </div>
      </header>

      <main className="lp-main">
        <div className="lp-centre">
          <h1>What should Divo work on?</h1>
          <p className="lp-lede">
            Divo reads and writes your Gmail, Drive, Sheets, Calendar, Lark and Zoho Books,
            and asks before it does anything it cannot take back.
          </p>

          <div className="bui-scope lp-comp">
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              placeholder="Ask Divo to export, compare, clean up, draft, or investigate…"
              autoFocus
              hero={1}
              /* No session, so no model list and nothing for a picker to offer.
                 See `picksModel` on the composer. */
              picksModel={false}
              models={NO_MODELS}
              modelSelection={null}
              onModelChange={() => undefined}
              onReasoningEffortChange={() => undefined}
            />
          </div>

          <p className="lp-foot">
            Press send and we will set you up. Four questions, then Divo answers this.
          </p>
        </div>
      </main>

      {asking ? (
        <Onboarding prompt={draft.trim()} onClose={() => setAsking(false)} onDone={run} />
      ) : null}
    </div>
  )
}
