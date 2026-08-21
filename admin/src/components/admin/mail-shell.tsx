/**
 * Divo Mail — the shell a member gets.
 *
 * Same layout primitives as `WorkspaceShell`, deliberately: identical rail
 * width, identical rows, identical page frame, so this reads as the same
 * product rather than a cut-down copy of one. What is gone is everything a
 * member cannot act on — the scope switcher, the ⌘K palette that mostly listed
 * settings pages, and the Settings takeover with its groups. Approvals,
 * Automations and Things Divo made used to be on that list too; they have since
 * been retired from the workspace shell as well, so there is nothing left to
 * withhold.
 *
 * What is left is what they were given Divo for. Mail rules, what those rules
 * caught, the brief, and a settings page that fits on one screen.
 *
 * The rail is short enough that no group labels are needed, which is its own
 * argument: the moment this needs headings it has stopped being Mail.
 *
 * A member who is later made a manager or an admin does not migrate. Their next
 * session carries a second scope, `surfaceFor` answers `workspace`, and they
 * get the full app — see `auth/surface.ts`.
 */
import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  House, Inbox, LogOut, Mail, Moon, Settings, Sun, type LucideIcon,
} from 'lucide-react'
import { DivoMark } from '@/components/admin/divo-mark'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { RoleProvider } from '@/cursor/role-context'
import { useTheme } from '@/lib/use-theme'
import '@/styles/workspace.css'

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }

/*
 * Three rows, and none of them is an inbox.
 *
 * A read-only mail list inside Divo is a worse Gmail sitting one tab away from
 * the real one, and putting it here would promise search, reply and archive
 * that are not coming. "Caught" is the opposite thing — it is not your mail, it
 * is the record of what Divo did with some of it.
 */
const NAV: NavItem[] = [
  // Home is the answer to "has this been working", which Rules and Caught can
  // only be read to infer. It leads because it is the question somebody opens
  // the app with; the two pages under it are where that answer is checked.
  { to: '/me/home', label: 'Home', icon: House, end: true },
  { to: '/me/mail', label: 'Rules', icon: Mail, end: true },
  { to: '/me/caught', label: 'Caught', icon: Inbox },
]

export function MailShell() {
  const { session, logout } = useAdminAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const { resolved, setTheme } = useTheme()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Land at the top of a new screen, as the workspace shell does — without it a
  // short page opens scrolled to wherever the previous one was.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [location.pathname])

  const first = (session?.name ?? '').trim().split(/\s+/)[0]

  return (
    <RoleProvider>
      <div className="cur app">
        <aside className="sidebar">
          {/*
            The workspace's switcher row, held static. There is exactly one
            scope here, so it is identity rather than a control — and the
            `data-static` variant already exists for that case, which is why
            this needs no styling of its own.
          */}
          <div className="ws-scope">
            <button type="button" className="ws-scope-btn" data-static="true">
              <span className="ws-scope-ic" data-tone="brand">
                <DivoMark size={14} />
              </span>
              <span className="ws-scope-txt">
                <b>Divo Mail</b>
                <span>{session?.companyName ?? ''}</span>
              </span>
            </button>
          </div>

          <nav className="ws-nav">
            <div style={{ height: 8 }} />
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <span className="g"><item.icon size={16} /></span>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="sidebar-foot">
            {/*
              Settings is a page in this app, not a takeover. A member's whole
              configuration is five facts and a mailbox; sending them through a
              door into a second shell to read it would be the app insisting it
              is bigger than it is.
            */}
            <NavLink
              to="/me/settings"
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="g"><Settings size={16} /></span>
              Settings
            </NavLink>
            <button
              type="button"
              className="nav-item"
              onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
            >
              <span className="g">{resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
              {resolved === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button type="button" className="nav-item" onClick={() => logout()}>
              <span className="g"><LogOut size={16} /></span>
              Sign out
            </button>
          </div>
        </aside>

        <div className="shell">
          <header className="topbar">
            <b className="ws-crumb-now">
              {NAV.find((i) => location.pathname.startsWith(i.to))?.label
                ?? (location.pathname.startsWith('/me/settings')
                  ? 'Settings'
                  : first ? `${first}’s mail` : 'Mail')}
            </b>
          </header>

          <div className="content">
            <div className="scroll" ref={scrollRef}>
              <Outlet />
            </div>
          </div>
        </div>
      </div>
    </RoleProvider>
  )
}
