/**
 * The auth shell — sign in, sign up, accept an invite, finish an OAuth hop.
 *
 * Rebuilt on the same `--cur-*` tokens as the Workspace shell. It used to be
 * the last shadcn surface left, which meant every person met one design
 * language on the login screen and a different one the moment they got in.
 *
 * The left panel says what this thing is and what you can do once you are in.
 * It previously advertised the radius scale and "Admin APIs only", which is
 * design-system trivia leaking onto a product page — nobody signing in cares,
 * and it made the console look like a demo of itself.
 */
import type { ReactNode } from 'react'
import { Diamond, Gauge, Moon, ShieldCheck, Sun, Users } from 'lucide-react'
import { useTheme } from '@/lib/use-theme'

type AuthCardProps = {
  title: string
  description: string
  children: ReactNode
}

export function AuthCard({ title, description, children }: AuthCardProps) {
  const { resolved, setTheme } = useTheme()

  return (
    <div className="cur">
      <div className="ws-auth">
        <aside className="ws-auth-aside">
          <div>
            <div className="brand" style={{ padding: '0 0 40px' }}>
              <span className="mark"><Diamond size={13} fill="currentColor" strokeWidth={0} /></span>
              <b className="display">Divo</b>
            </div>
            <h1>The console behind the agent.</h1>
            <p>
              Divo runs inside Lark and on the desktop. This is where you decide what it may do, for whom, and
              what that costs.
            </p>
            <div className="ws-auth-list">
              <div>
                <ShieldCheck size={15} />
                <div>
                  <b>Permissions people can actually read</b>
                  <p>Every grant says where it came from and what it lets Divo do, in plain words.</p>
                </div>
              </div>
              <div>
                <Gauge size={15} />
                <div>
                  <b>Real cost, not an estimate</b>
                  <p>Priced from the token counts each run actually reported, split by cache.</p>
                </div>
              </div>
              <div>
                <Users size={15} />
                <div>
                  <b>One place for members, managers and admins</b>
                  <p>The same app reshapes around who you are — no second console to learn.</p>
                </div>
              </div>
            </div>
          </div>
          <div className="ws-auth-foot">One sign-in for everyone — the same account works here, in Lark, and on the desktop.</div>
        </aside>

        <main className="ws-auth-main">
          <button
            type="button"
            className="icon-btn ws-auth-theme"
            title={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
          >
            {resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>

          <div className="ws-auth-box">
            {/* Shown only where the aside is hidden, so the page still identifies itself. */}
            <div className="brand" style={{ padding: 0 }}>
              <span className="mark"><Diamond size={13} fill="currentColor" strokeWidth={0} /></span>
              <b className="display">Divo</b>
            </div>
            <h2>{title}</h2>
            <p>{description}</p>
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

/* ── Form primitives ──────────────────────────────────
   Small on purpose. These four cover every auth form in the app, and keeping
   them here stops the pages from reaching back into the shadcn set. */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="ws-field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export function AuthError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="ws-auth-err" role="alert">
      <TriangleGlyph />
      <span>{message}</span>
    </div>
  )
}

const TriangleGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
)
