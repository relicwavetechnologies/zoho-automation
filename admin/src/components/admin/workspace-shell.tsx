/**
 * The Workspace shell — the real one, driven by the authenticated session.
 *
 * This replaces AdminShell. Same structural idea as the mock: scope is
 * explicit (You / Your team / Company) and the nav reshapes beneath it, so a
 * person who is both an individual and a lead is never left guessing whether
 * "Connections" means theirs or their team's.
 *
 * Company-scope items route to the existing, live admin pages. You and Team
 * route to the Workspace screens, which are still on fixtures — every one of
 * them marks itself in the UI, so nothing here implies more is wired than is.
 *
 * Scope availability: an admin session is only ever issued to SUPER_ADMIN or
 * COMPANY_ADMIN today (admin-auth.routes.ts), so Company is present for
 * everyone who can sign in. Team has no data source yet — `/me` reports
 * departments but the admin session does not carry managed departments — so it
 * is shown as a preview until that lands.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, Bell, Brain, Building2, Check, ChevronsUpDown, Diamond, FileClock, FileStack,
  Gauge, Grid2X2, KeyRound, Library, Link2, LogOut, Moon, Search, Settings, ShieldCheck,
  Sun, Users, UserSquare, type LucideIcon,
} from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { RoleProvider } from '@/cursor/role-context'
import { useTheme } from '@/lib/use-theme'
import '@/styles/workspace.css'

type ScopeKind = 'you' | 'team' | 'company'
type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }
type NavGroup = { label?: string; items: NavItem[] }

const NAV: Record<ScopeKind, NavGroup[]> = {
  you: [
    {
      items: [
        { to: '/me', label: 'Home', icon: Grid2X2, end: true },
        { to: '/me/approvals', label: 'Approvals', icon: ShieldCheck },
      ],
    },
    {
      label: 'Your setup',
      items: [
        { to: '/me/artifacts', label: 'Things Divo made', icon: FileStack },
        { to: '/me/connections', label: 'Connected apps', icon: Link2 },
        { to: '/me/access', label: 'What Divo can do', icon: KeyRound },
        { to: '/me/skills', label: 'Skills', icon: Library },
        { to: '/me/memory', label: 'Memory', icon: Brain },
      ],
    },
    {
      label: 'Account',
      items: [
        { to: '/me/usage', label: 'Usage', icon: Gauge },
        { to: '/me/settings', label: 'Settings', icon: Settings },
      ],
    },
  ],
  team: [
    {
      items: [
        { to: '/team', label: 'Overview', icon: Grid2X2, end: true },
        { to: '/team/people', label: 'People', icon: Users },
      ],
    },
    {
      label: 'Access',
      items: [
        { to: '/team/roles', label: 'Roles', icon: UserSquare },
        { to: '/team/approvals', label: 'Ask me first', icon: ShieldCheck },
      ],
    },
    { label: 'Account', items: [{ to: '/team/usage', label: 'Usage', icon: Gauge }] },
  ],
  company: [
    {
      items: [
        { to: '/home', label: 'Overview', icon: Grid2X2 },
        { to: '/people', label: 'Everyone', icon: Users },
        { to: '/departments', label: 'Departments', icon: Building2 },
      ],
    },
    {
      label: 'Operations',
      items: [
        { to: '/ai-ops', label: 'AI Ops', icon: Activity },
        { to: '/skills', label: 'Skills', icon: Library },
        { to: '/memories', label: 'Memory', icon: Brain },
      ],
    },
    {
      label: 'Governance',
      items: [
        { to: '/policy', label: 'Company ceiling', icon: KeyRound },
        { to: '/connections', label: 'Connections', icon: Link2 },
        { to: '/guardrails', label: 'Guardrails', icon: Gauge },
        { to: '/activity', label: 'Activity', icon: FileClock },
      ],
    },
  ],
}

const scopeOfPath = (pathname: string): ScopeKind =>
  pathname.startsWith('/me') ? 'you' : pathname.startsWith('/team') ? 'team' : 'company'

const HOME: Record<ScopeKind, string> = { you: '/me', team: '/team', company: '/home' }

/** Two letters from a name, falling back to the email's local part. */
const initialsOf = (name?: string | null, email?: string | null): string => {
  const source = name?.trim() || email?.split('@')[0] || ''
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '·'
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]
  return letters.toUpperCase()
}

const roleLabel = (role?: string): string =>
  role === 'SUPER_ADMIN' ? 'Super admin' : role === 'COMPANY_ADMIN' ? 'Company admin' : 'Member'

export function WorkspaceShell() {
  const { session, scopes, logout } = useAdminAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const { resolved, setTheme } = useTheme()
  const [scopeOpen, setScopeOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Land at the top of a new screen. Without this the router keeps the previous
  // page's offset, so a short page opens scrolled past its own header.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [location.pathname])

  const scope = scopeOfPath(location.pathname)
  const groups = NAV[scope]

  // Scopes come from the session now — a Team scope appears only when this
  // person actually leads a department, and Company only when their live
  // membership is admin. The old list showed all three to everyone and labelled
  // Team a "preview", which meant the switcher advertised a place to go that
  // had no data and no right to any.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!scopeOpen) return
    const onDown = (e: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) setScopeOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [scopeOpen])

  const active = scopes.find((s) => s.kind === scope) ?? scopes[0]
  const ScopeIcon = scope === 'you' ? UserSquare : scope === 'team' ? Users : Building2

  return (
    <RoleProvider>
      <div className="cur app">
        <aside className="sidebar">
          <div className="brand">
            <span className="mark"><Diamond size={13} fill="currentColor" strokeWidth={0} /></span>
            <b className="display">Divo</b>
          </div>

          <div className="ws-scope" ref={scopeRef}>
            <button
              type="button"
              className={`ws-scope-btn${scopeOpen ? ' open' : ''}`}
              data-static={scopes.length === 1}
              onClick={scopes.length === 1 ? undefined : () => setScopeOpen((v) => !v)}
            >
              <span className="ws-scope-ic" data-tone={scopes.length === 1 ? 'ink' : undefined}>
                <ScopeIcon size={14} />
              </span>
              <span className="ws-scope-txt">
                <b>{active.label}</b>
                <span>{active.detail}</span>
              </span>
              {scopes.length > 1 ? <ChevronsUpDown size={14} className="muted" /> : null}
            </button>

            {scopeOpen && scopes.length > 1 ? (
              <div className="ws-scope-menu">
                {scopes.map((s) => {
                  const Icon = s.kind === 'you' ? UserSquare : s.kind === 'team' ? Users : Building2
                  return (
                    <button
                      type="button"
                      key={s.kind}
                      className="ws-scope-opt"
                      onClick={() => { setScopeOpen(false); navigate(HOME[s.kind]) }}
                    >
                      <span className="ws-scope-ic"><Icon size={13} /></span>
                      <span className="ws-scope-txt"><b>{s.label}</b><span>{s.detail}</span></span>
                      {s.kind === scope ? <Check size={14} className="ck" /> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>

          <nav className="ws-nav">
            {groups.map((group, gi) => (
              <div key={gi}>
                {group.label ? <div className="nav-label">{group.label}</div> : <div style={{ height: 8 }} />}
                {group.items.map((item) => (
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
              </div>
            ))}
          </nav>

          <div className="sidebar-foot">
            {/* The person, not their rank. Members sign in here now, and
                "Company admin" was printed for everyone regardless. */}
            <button type="button" className="ws-acct" onClick={() => logout()}>
              <span className="avatar">{initialsOf(session?.name, session?.email)}</span>
              <span className="ws-acct-txt">
                <b>{session?.name ?? session?.email ?? 'Signed in'}</b>
                <span>{roleLabel(session?.role)}</span>
              </span>
              <LogOut size={14} className="muted" />
            </button>
          </div>
        </aside>

        <div className="shell">
          <header className="topbar">
            <div className="ws-crumb">
              <button type="button" onClick={() => navigate(HOME[scope])}>{active.label}</button>
              <span>/</span>
              <b>{groups.flatMap((g) => g.items).find((i) => i.to === location.pathname)?.label ?? 'Detail'}</b>
            </div>

            <button
              type="button"
              className="search"
              onClick={() => setPalette(true)}
              style={{ maxWidth: 240, cursor: 'pointer' }}
            >
              <Search size={14} />
              <span style={{ flex: 1, textAlign: 'left' }}>Search</span>
              <span className="ws-kbd">⌘K</span>
            </button>

            <button
              type="button"
              className="icon-btn"
              title={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
              onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
            >
              {resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>

            <button type="button" className="icon-btn" title="Notifications"><Bell size={15} /></button>
          </header>

          <div className="content">
            <div className="scroll" ref={scrollRef}>
              <Outlet />
            </div>
          </div>
        </div>

        {palette ? (
          <Palette
            items={groups.flatMap((g) => g.items)}
            onClose={() => setPalette(false)}
            onPick={(to) => { navigate(to); setPalette(false) }}
          />
        ) : null}
      </div>
    </RoleProvider>
  )
}

function Palette({ items, onClose, onPick }: {
  items: NavItem[]; onClose: () => void; onPick: (to: string) => void
}) {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const results = useMemo(() => items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [items, q])

  useEffect(() => setCursor(0), [q])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
      if (e.key === 'Enter' && results[cursor]) onPick(results[cursor].to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, cursor, onClose, onPick])

  return (
    <div className="ws-pal-wrap">
      <div className="ws-scrim" onClick={onClose} />
      <div className="ws-pal">
        <div className="ws-pal-in">
          <Search size={15} className="muted" />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Go to…" />
          <span className="ws-kbd">esc</span>
        </div>
        <div className="ws-pal-l">
          {results.length === 0 ? (
            <div className="ws-pal-empty">Nothing matches “{q}”</div>
          ) : (
            results.map((r, i) => (
              <button
                type="button"
                key={r.to}
                className={`ws-pal-i${i === cursor ? ' on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onPick(r.to)}
              >
                <r.icon size={15} className="muted" />
                {r.label}
                {i === cursor ? <span className="sc">↵</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
