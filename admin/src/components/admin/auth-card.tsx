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
import { Gauge, Moon, ShieldCheck, Sun, Users } from 'lucide-react'
import { DivoMark } from '@/components/admin/divo-mark'
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
        {/* Page-level, not inside either half. It lived in the panel for a
            moment, which put the only way to change theme inside the one column
            that disappears on a narrow screen. */}
        <button
          type="button"
          className="icon-btn ws-auth-theme"
          title={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
        >
          {resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        {/*
         * The form, on the left, where reading starts.
         *
         * It used to be on the right with the argument on the left, so the one
         * thing a person came here to do was the second thing they reached. The
         * onboarding modal made the same swap for the same reason; a person
         * signing in and a person signing up should not meet opposite layouts.
         */}
        <main className="ws-auth-main">
          <div className="ws-auth-box">
            <div className="brand" style={{ padding: 0 }}>
              <span className="mark"><DivoMark size={15} /></span>
              <b className="display">Divo</b>
            </div>
            <h2>{title}</h2>
            <p>{description}</p>
            {children}
          </div>
        </main>

        {/*
         * The right half is the argument, and it is made of things this product
         * actually does.
         *
         * The reference this was rebuilt against puts a customer quote here,
         * with a face and five stars. Divo has no such quote, and inventing one
         * would be putting a fabricated review on the front door of the app. The
         * claims below are checkable in the product, which is a better argument
         * than a stranger agreeing with us.
         */}
        <aside className="ws-auth-aside">
          <div className="ws-auth-pitch">
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

          <div className="ws-auth-foot">
            <span>One sign-in for everyone — the same account works here, in Lark, and on the desktop.</span>
            <a className="ws-auth-attribution" href="https://logo.dev" target="_blank" rel="noopener">
              Logos provided by Logo.dev
            </a>
          </div>
        </aside>
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
