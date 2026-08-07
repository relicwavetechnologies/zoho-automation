/**
 * Divo Mail — the packaged member product, as a navigable proposal.
 *
 * This route is a *pitch*, not a feature. It exists so the shape of the thing
 * can be argued about by clicking it rather than by reading a spec: sign in
 * with Lark, connect a mailbox, build one rule with an AI step in the middle,
 * watch what it caught, open the message behind a decision, get a brief.
 *
 * Three deliberate properties:
 *
 *  · **Nothing is wired.** Every screen runs on `./data`. A prototype that
 *    half-fetches breaks in the room where you are trying to show it, and a
 *    prototype that fully fetches cannot show the states that matter — first
 *    run, and everything broken.
 *
 *  · **It wears its own shell.** The real workspace rail carries Approvals,
 *    Automations, Things Divo made, a scope switcher and a Settings takeover.
 *    A member being handed mail sees four rows and nothing else. Reusing
 *    `WorkspaceShell` here would have argued the opposite case by accident.
 *
 *  · **It is unauthenticated.** Outside `<Protected>`, so the link can be
 *    opened by anyone being shown it, on any machine, with no session.
 *
 * The annotation toggle in the corner is the whole reason it is worth building
 * this rather than drawing it: with notes off it reads as a product, with notes
 * on every screen argues for itself in place.
 */
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  Building2, Clock, Mail, MessageSquare, Moon, Settings as SettingsIcon,
  StickyNote, Sun, Zap,
} from 'lucide-react'
import { useTheme } from '@/lib/use-theme'
import '@/styles/workspace.css'
import '@/styles/mail-preview.css'
import { DivoMark, PreviewProvider, usePreview } from './kit'
import { ME, type Mode } from './data'
import {
  AdminView, BriefScreen, CaughtFeed, Connect, EditRule, LarkView, MessageScreen, NewRule,
  RuleDetail, Rules, Settings, SignIn,
} from './screens'

/*
 * The member's whole world. Four rows, one of them Settings.
 *
 * There is no Inbox. It was drawn, built, and cut: a read-only mail list
 * inside Divo is a worse Gmail sitting one tab away from the real one, and
 * putting it in the rail promises search, reply and archive that are not
 * coming. The message view survives as a link target — see `reader.tsx`.
 */
const NAV = [
  { to: '/preview/mail/rules', label: 'Rules', icon: Zap },
  { to: '/preview/mail/caught', label: 'Caught', icon: Mail },
  { to: '/preview/mail/brief', label: 'Brief', icon: Clock },
]

const MODES: { id: Mode; label: string }[] = [
  { id: 'first-run', label: 'First run' },
  { id: 'running', label: 'Running' },
  { id: 'trouble', label: 'Something is wrong' },
]

/**
 * The prototype's own controls, floating over the product.
 *
 * Kept visually apart from everything else — dark chrome, bottom of the screen
 * — because the one thing worse than an unannotated prototype is one where the
 * viewer cannot tell which controls belong to the product being proposed.
 */
function PrototypeBar() {
  const { mode, setMode, notes, setNotes } = usePreview()
  const { resolved, setTheme } = useTheme()
  const nav = useNavigate()
  const { pathname } = useLocation()

  return (
    <div className="mp-bar">
      <span className="mp-bar-l">Prototype</span>

      <div className="mp-bar-seg">
        {MODES.map((m) => (
          <button key={m.id} type="button" data-on={m.id === mode} onClick={() => setMode(m.id)}>{m.label}</button>
        ))}
      </div>

      <button type="button" className="mp-bar-b" data-on={notes} onClick={() => setNotes(!notes)}>
        <StickyNote size={13} /> Annotations
      </button>

      <button
        type="button"
        className="mp-bar-b"
        data-on={pathname.endsWith('/lark')}
        onClick={() => nav(pathname.endsWith('/lark') ? '/preview/mail/rules' : '/preview/mail/lark')}
      >
        <MessageSquare size={13} /> Lark
      </button>

      <button
        type="button"
        className="mp-bar-b"
        data-on={pathname.endsWith('/admin')}
        onClick={() => nav(pathname.endsWith('/admin') ? '/preview/mail/rules' : '/preview/mail/admin')}
      >
        <Building2 size={13} /> Admin
      </button>

      <button type="button" className="mp-bar-b" onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}>
        {resolved === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
      </button>

      <button type="button" className="mp-bar-b" onClick={() => nav('/preview/mail/signin')}>
        Restart
      </button>
    </div>
  )
}

function Shell() {
  const { signedIn } = usePreview()
  const nav = useNavigate()
  if (!signedIn) return <Navigate to="/preview/mail/signin" replace />

  return (
    <div className="cur app mp-app">
      <aside className="sidebar mp-side">
        <button type="button" className="mp-brand" onClick={() => nav('/preview/mail/rules')}>
          <span className="mp-brand-ic"><DivoMark size={12} /></span>
          <span className="mp-brand-t">
            <b>Divo Mail</b>
            <span>{ME.company}</span>
          </span>
        </button>

        <nav className="ws-nav">
          <div style={{ height: 8 }} />
          {NAV.map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span className="g"><i.icon size={16} /></span>
              {i.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <NavLink to="/preview/mail/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span className="g"><SettingsIcon size={16} /></span>
            Settings
          </NavLink>
          <div className="mp-acct">
            <span className="mp-av sm">{ME.initials}</span>
            <div>
              <b>{ME.name}</b>
              <span>{ME.email}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Inside `.cur`, not beside it — the bar is styled with `--cur-*`
          tokens and those only exist on this subtree. */}
      <PrototypeBar />

      <main className="mp-main">
        <Routes>
          <Route index element={<Navigate to="/preview/mail/rules" replace />} />
          <Route path="rules" element={<Rules />} />
          <Route path="rules/new" element={<NewRule />} />
          <Route path="rules/:ruleId" element={<RuleDetail />} />
          <Route path="rules/:ruleId/edit" element={<EditRule />} />
          <Route path="caught" element={<CaughtFeed />} />
          <Route path="brief" element={<BriefScreen />} />
          <Route path="settings" element={<Settings />} />
          <Route path="connect" element={<Connect />} />
          {/* Reachable only from a Caught row or a brief line. */}
          <Route path="message/:threadId" element={<MessageScreen />} />
          {/* Outside the member's nav on purpose — reachable only from the
              prototype bar, because a member is never shown either. */}
          <Route path="lark" element={<LarkView />} />
          <Route path="admin" element={<AdminView />} />
          <Route path="*" element={<Navigate to="/preview/mail/rules" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export function MailPreview() {
  return (
    <PreviewProvider>
      <Routes>
        {/* No shell: the sign-in screen is what somebody sees before there is
            an app to put around them. */}
        <Route path="signin" element={<div className="cur mp-plain"><SignIn /><PrototypeBar /></div>} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </PreviewProvider>
  )
}

export default MailPreview
