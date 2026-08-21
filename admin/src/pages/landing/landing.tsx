/**
 * `/` for somebody who is not signed in.
 *
 * The same composer Home has, in the same shell Home sits in, with everything
 * that needs a session left out. No recent chats, no scope switcher, no getting
 * started, no app tray read off connections that do not exist yet.
 *
 * Why this page exists: `/` used to bounce a signed-out visitor straight to
 * `/login`, so the first thing Divo ever showed anybody was a password field. A
 * product whose whole proposition is "ask it in words" opening on a form
 * contradicts itself before it has said anything.
 *
 * It keeps the rail rather than clearing the screen, which is the arrangement
 * ChatGPT settled on and for a reason worth copying: an empty page with one box
 * on it says "this is a text field", and a page with the product's own frame
 * around that box says "this is the product, and you are already in it". The
 * rail is also where the honest answer to "what can this thing do" goes, which
 * signed out is the list of things Divo works with rather than a chat history.
 *
 * What it does *not* copy is the centred hero. Our signed-in Home sets its
 * greeting and composer left in a fixed column, and if this page centred them
 * the whole layout would shunt sideways the moment somebody finished signing
 * up. Same product, same position.
 *
 * Sending does not start a run — there is no account to run it under. It keeps
 * the sentence and opens onboarding over the top, and once that finishes the
 * sentence is the first thing Divo answers. `/login` is untouched and is still
 * where people with an account go.
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Moon, Plus, Sun } from 'lucide-react'
import { DivoMark } from '@/components/admin/divo-mark'
import { useTheme } from '@/lib/use-theme'
import { BrandMark } from '@/components/admin/brand-mark'
import { Composer } from '@/pages/workspace/chat/composer'
import { appChips, withReference } from '@/pages/workspace/home/apps'
import { stageHandoff } from '@/pages/workspace/chat/handoff'
import { newThreadId } from '@/pages/workspace/chat/threads'
import { Onboarding } from './onboarding'
import '@/styles/beautiful.css'
import './landing.css'

const NO_MODELS = [] as const

/**
 * The apps under the box, exactly as Home draws them.
 *
 * Signed in, `appChips` is fed the connections somebody actually has. Signed
 * out there is nobody to derive them from, so the providers are fixed — but
 * they go through the same function, so the row is built the same way, in the
 * same order, and a new app added to `home/apps.ts` appears here too.
 *
 * They lived in the rail for one iteration and were worse there. A logo in a
 * nav list reads as a page you can open, and none of these are pages. Under the
 * composer they read as what they are: things the sentence above them can be
 * pointed at.
 */
const WORKS_WITH = appChips(['google_workspace', 'lark', 'zoho'])

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
     account, and the point of the whole flow is that it still runs. */
  const run = (): void => {
    const asked = draft.trim()
    if (asked) stageHandoff(asked)
    navigate(asked ? `/chat/${newThreadId()}` : '/', { replace: true })
  }

  return (
    /* The real shell's own classes, so the rail is the same width and the same
       colour it will be a minute from now. Only `lp` is this page's. */
    <div className="cur app workspace-app lp">
      <aside className="sidebar workspace-sidebar" aria-label="Divo">
        <div className="brand">
          <span className="mark"><DivoMark size={15} /></span>
          <b className="display">Divo</b>
        </div>

        <button type="button" className="ws-new-chat" onClick={() => setDraft('')}>
          <span>New chat</span>
          <span className="ws-new-chat-plus" aria-hidden="true"><Plus size={10} /></span>
        </button>

        <div className="sidebar-foot">
          <button
            type="button"
            className="nav-item"
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
          >
            <span className="g">{resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</span>
            <span>{resolved === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>

          {/* Where the account rows are once there is an account. Says what
              signing in gets you rather than only asking for it. */}
          <div className="lp-signin">
            <b>Sign in to keep your work</b>
            <p>Your chats, connected apps and approvals live in a workspace.</p>
            <Link className="lp-signin-btn" to="/login">Log in</Link>
          </div>
        </div>
      </aside>

      <div className="lp-body">
        <header className="lp-top">
          {/* Only once the rail is gone. Above that it would be the wordmark
              twice, a centimetre apart. */}
          <div className="brand lp-top-brand">
            <span className="mark"><DivoMark size={15} /></span>
            <b className="display">Divo</b>
          </div>
          <Link className="lp-btn" to="/login">Log in</Link>
          <button type="button" className="lp-btn lp-btn-solid" onClick={() => setAsking(true)}>
            Create workspace
          </button>
        </header>

        <main className="lp-main">
          <div className="lp-centre">
            <h1>What should Divo work on?</h1>
            <p className="lp-lede">
              Divo reads and writes your mail, files, sheets, calendar and books,
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
                /* No session, so no model list and nothing for a picker to
                   offer. See `picksModel` on the composer. */
                picksModel={false}
                models={NO_MODELS}
                modelSelection={null}
                onModelChange={() => undefined}
                onReasoningEffortChange={() => undefined}
                /* The same chips, the same class, the same writer as Home. A
                   press types the app's name into the box and does nothing
                   else, so it promises nothing about scopes. */
                actions={WORKS_WITH.map((app) => (
                  <button
                    key={app.key}
                    type="button"
                    className="ws-app-chip"
                    title={app.label}
                    aria-label={`Ask about ${app.label}`}
                    onClick={() => setDraft(withReference(draft, app))}
                  >
                    <BrandMark brand={app.key} size={17} />
                  </button>
                ))}
              />
            </div>

            <p className="lp-foot">
              Press send and we will set you up. Four questions, then Divo answers this.
            </p>
          </div>
        </main>
      </div>

      {asking ? (
        <Onboarding prompt={draft.trim()} onClose={() => setAsking(false)} onDone={run} />
      ) : null}
    </div>
  )
}
