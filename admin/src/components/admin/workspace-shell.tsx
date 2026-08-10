/**
 * The Workspace shell — the real one, driven by the authenticated session.
 *
 * This replaces AdminShell. Same structural idea as the mock: scope is
 * explicit (You / Your team / Company) and the nav reshapes beneath it, so a
 * person who is both an individual and a lead is never left guessing whether
 * "Connections" means theirs or their team's.
 *
 * Every scope now runs on real endpoints. A few panels are still fixtures —
 * /me/skills, /me/memory and /me/artifacts — and each marks itself in the UI
 * rather than relying on a note here that goes stale the moment one is wired.
 *
 * Scope availability: one member session serves everybody, so Team appears for
 * whoever actually manages a department and Company for admins. Nothing is
 * shown as a preview any more.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, Bot, Building2, Check, ChevronsUpDown, CircleCheck, CircleDashed, Diamond, FileClock,
  FileStack, Grid2X2, LogOut, Mail, Minus, Moon, Plus, Search, Settings, ShieldCheck, Sun,
  Users, UserSquare, type LucideIcon,
} from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useManagedDepartments } from '@/pages/workspace/data/use-team'
import { useOnboarding, useRecentRuns } from '@/pages/workspace/data/use-onboarding'
import { runTitle } from '@/pages/workspace/data/use-my-activity'
import { RAIL } from '@/components/admin/settings-shell'
import { RoleProvider } from '@/cursor/role-context'
import { useTheme } from '@/lib/use-theme'
import '@/styles/workspace.css'

type ScopeKind = 'you' | 'team' | 'company'
type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }
type NavGroup = { label?: string; items: NavItem[] }

/*
 * The work surface, and only that.
 *
 * Everything a person *sets up* moved to the Settings takeover, which is why
 * this list is now short enough to read at a glance. It used to run to ten
 * rows for a member, most of them configuration they open once a quarter, and
 * the two things they actually came to do were lost among them.
 */
const NAV: Record<ScopeKind, NavGroup[]> = {
  you: [
    {
      items: [
        { to: '/me', label: 'Home', icon: Grid2X2, end: true },
        /* Work, not configuration: a mail rule is Divo acting on your behalf
           every hour of every day, and you come back to check it still is. */
        { to: '/me/mail', label: 'Mail', icon: Mail },
        { to: '/me/approvals', label: 'Approvals', icon: ShieldCheck },
        { to: '/me/automations', label: 'Automations', icon: Bot },
        { to: '/me/artifacts', label: 'Things Divo made', icon: FileStack },
      ],
    },
  ],
  team: [
    { items: [{ to: '/team', label: 'Overview', icon: Grid2X2, end: true }] },
  ],
  company: [
    {
      items: [
        { to: '/home', label: 'Overview', icon: Grid2X2 },
        /* Watching the company is work. Governing it is configuration, and
           that half now lives behind Settings. */
        { to: '/ai-ops', label: 'AI Ops', icon: Activity },
        { to: '/activity', label: 'Activity', icon: FileClock },
      ],
    },
  ],
}

const scopeOfPath = (pathname: string): ScopeKind =>
  pathname.startsWith('/me') ? 'you' : pathname.startsWith('/team') ? 'team' : 'company'

const HOME: Record<ScopeKind, string> = { you: '/me', team: '/team', company: '/home' }

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

  // Which team the Team scope is about. A person can lead several, and every
  // Team entry in this menu points at the same `/team` — the department is
  // carried in the remembered selection instead, so the label has to follow it
  // rather than always naming the first.
  const managed = useManagedDepartments()
  const active = scopes.find((s) => (
    s.kind === scope && (s.kind !== 'team' || s.departmentId === managed.department?.id)
  )) ?? scopes.find((s) => s.kind === scope) ?? scopes[0]
  const ScopeIcon = scope === 'you' ? UserSquare : scope === 'team' ? Users : Building2

  /*
   * Everywhere this person can go, both surfaces.
   *
   * The palette used to list the current scope's nav and nothing else. Now that
   * configuration lives behind Settings, that would be three rows — so it spans
   * both shells, filtered to the scopes the session actually holds. The same
   * filter the rail uses, for the same reason: never offer a door that will be
   * shut in your face.
   */
  const paletteItems = useMemo(() => {
    const held = new Set(scopes.map((s) => s.kind))
    return [
      ...Object.values(NAV).flat().flatMap((g) => g.items),
      ...RAIL.filter((g) => held.has(g.scope)).flatMap((g) => g.items),
    ].filter((item, i, all) => all.findIndex((x) => x.to === item.to) === i)
  }, [scopes])

  return (
    <RoleProvider>
      <div className="cur app">
        <aside className="sidebar">
          {/*
            No separate brand row. The reference folds identity into the
            workspace switcher — one row that says both who you are and which
            workspace you are in — and a "Divo" wordmark above a scope selector
            was two rows saying nearly the same thing. The mark lives inside the
            switcher now.
          */}
          <div className="ws-scope" ref={scopeRef}>
            <button
              type="button"
              className={`ws-scope-btn${scopeOpen ? ' open' : ''}`}
              data-static={scopes.length === 1}
              onClick={scopes.length === 1 ? undefined : () => setScopeOpen((v) => !v)}
            >
              <span className="ws-scope-ic" data-tone="brand">
                <Diamond size={12} fill="currentColor" strokeWidth={0} />
              </span>
              <span className="ws-scope-txt">
                <b>{active.label}</b>
              </span>
              {scopes.length > 1 ? <ChevronsUpDown size={13} className="muted" /> : null}
            </button>

            {/* The reference's top-right "+". It starts a new session there; the
                nearest honest thing here is the composer, so it goes to Home and
                puts the cursor in it rather than being a button that does
                nothing until chat exists. */}
            <button
              type="button"
              className="ws-scope-new"
              title="Ask Divo something"
              aria-label="Ask Divo something"
              onClick={() => {
                navigate('/me')
                // After the route paints. The composer marks itself so the shell
                // does not have to know anything else about Home.
                window.setTimeout(() => {
                  document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus()
                }, 60)
              }}
            >
              <Plus size={16} />
            </button>

            {scopeOpen && scopes.length > 1 ? (
              <div className="ws-scope-menu">
                {scopes.map((s) => {
                  const Icon = s.kind === 'you' ? UserSquare : s.kind === 'team' ? Users : Building2
                  // Keyed by department too. Two led departments produce two
                  // Team scopes, and keying on `kind` alone gave React duplicate
                  // keys and the reader two identical-looking rows.
                  const current = s.kind === scope
                    && (s.kind !== 'team' || s.departmentId === managed.department?.id)
                  return (
                    <button
                      type="button"
                      key={`${s.kind}:${s.departmentId ?? ''}`}
                      className="ws-scope-opt"
                      onClick={() => {
                        setScopeOpen(false)
                        if (s.kind === 'team' && s.departmentId) managed.select(s.departmentId)
                        navigate(HOME[s.kind])
                      }}
                    >
                      <span className="ws-scope-ic"><Icon size={13} /></span>
                      <span className="ws-scope-txt"><b>{s.label}</b><span>{s.detail}</span></span>
                      {current ? <Check size={14} className="ck" /> : null}
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

          {/* Personal to whoever is signed in, so they belong to the You scope
              and nowhere else — a manager reading their team's page does not
              want their own half-finished setup in the corner of it. */}
          {scope === 'you' ? (
            <>
              <RecentRuns onOpen={() => navigate('/me')} onSearch={() => setPalette(true)} />
              <GettingStarted onGo={(to) => navigate(to)} />
            </>
          ) : null}

          {/*
            Bottom rail, as in the reference: quiet rows rather than a boxed
            account card. Appearance sits here because there is no Settings
            takeover to hold it yet — when that page lands it moves inside and
            this row goes away.
          */}
          <div className="sidebar-foot">
            <NavLink to="/settings/profile" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
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
            {/* No name trailing this row. The switcher at the top already reads
                "<first name>'s workspace", so repeating it here only crowded a
                row that is one word wide. */}
            <button type="button" className="nav-item" onClick={() => logout()}>
              <span className="g"><LogOut size={16} /></span>
              Sign out
            </button>
          </div>
        </aside>

        <div className="shell">
          {/*
            The reference has no top chrome — a page begins with its own title
            and nothing else. Search moved to the Recent header and appearance
            to the sidebar foot, so nothing was lost; the bell went with them
            because it had no handler and never had one.
          */}
          <header className="topbar">
            <b className="ws-crumb-now">
              {groups.flatMap((g) => g.items).find((i) => i.to === location.pathname)?.label ?? active.label}
            </b>
          </header>

          <div className="content">
            <div className="scroll" ref={scrollRef}>
              <Outlet />
            </div>
          </div>
        </div>

        {palette ? (
          <Palette
            items={paletteItems}
            onClose={() => setPalette(false)}
            onPick={(to) => { navigate(to); setPalette(false) }}
          />
        ) : null}
      </div>
    </RoleProvider>
  )
}

/**
 * Recent runs, in the sidebar.
 *
 * There is nowhere to open a single run from the You scope yet — run detail is
 * an admin route — so a row goes to All activity rather than pretending to
 * deep-link. It will point at the run itself once that page exists for members.
 */
/**
 * "16h", not "16 hours ago".
 *
 * The rail's own second line, under a title it belongs to — there is no
 * sentence for the long form to complete, and at five entries the words were
 * wider than the run names above them. `ago()` stays for the pages, where a row
 * is read rather than scanned.
 */
function shortAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.round(days / 7)}w`
}

/**
 * Which colour the dot takes.
 *
 * `running` is deliberately unreachable for Lark: the backend never closes a
 * Lark run, so every one of them reports `running` indefinitely — see the
 * "status unknown" note the run lists carry for the same reason. A rail of five
 * permanently-live dots would say nothing at all, so those read as done.
 */
function runDotState(run: { status: string; channel: string }): 'ok' | 'err' | 'run' {
  if (run.status === 'failed') return 'err'
  if (run.status === 'running' && run.channel !== 'lark') return 'run'
  return 'ok'
}

function RecentRuns({ onOpen, onSearch }: { onOpen: () => void; onSearch: () => void }) {
  const { runs, loading } = useRecentRuns(5)

  // Nothing at all is not worth a heading. A person who has never asked Divo
  // anything is served by the Getting started card below, not by an empty list.
  if (loading || runs.length === 0) return null

  return (
    <div className="ws-recent">
      <div className="ws-recent-hd">
        <span className="nav-label">Recent</span>
        {/* The reference pairs this with a filter control. There is nothing to
            filter a five-item list by yet, so only the one that works is here. */}
        <button type="button" className="ws-recent-ic" onClick={onSearch} title="Search (⌘K)" aria-label="Search">
          <Search size={14} />
        </button>
      </div>
      {runs.map((run) => (
        <button type="button" className="ws-recent-item" key={run.id} onClick={onOpen}>
          <b>{runTitle(run)}</b>
          {/*
            A dot before the time, because the age of a run is only half of what
            somebody scanning this rail wants — "22h" reads the same whether it
            worked or failed, and a failure sitting quietly in the list is the
            one entry they would have wanted to notice.

            Lark runs are excluded from `running` on purpose: the backend never
            closes them, so every Lark run stays "running" forever and a live
            dot on all five would mean nothing.
          */}
          <span data-state={runDotState(run)}>
            <i className="ws-recent-dot" />
            {shortAgo(run.startedAt)}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * Onboarding progress.
 *
 * Retires itself the moment every step is done rather than sitting at 100%
 * forever, and can be collapsed before then. Both are remembered locally —
 * nothing on the backend stores either.
 */
function GettingStarted({ onGo }: { onGo: (to: string) => void }) {
  const { steps, percent, complete, loading } = useOnboarding()
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem('divo.onboarding.collapsed') === '1',
  )

  const toggle = () => {
    setCollapsed((v) => {
      const next = !v
      try { window.localStorage.setItem('divo.onboarding.collapsed', next ? '1' : '0') } catch { /* private mode */ }
      return next
    })
  }

  if (loading || complete) return null

  return (
    <div className="ws-onb">
      <div className="ws-onb-hd">
        <b>Getting started</b>
        <button
          type="button"
          className="ws-onb-tog"
          onClick={toggle}
          aria-label={collapsed ? 'Expand getting started' : 'Collapse getting started'}
        >
          {collapsed ? <Plus size={14} /> : <Minus size={14} />}
        </button>
      </div>
      <div className="ws-onb-prog">
        <div className="ws-onb-bar"><i style={{ width: `${percent}%` }} /></div>
        <span>{percent}%</span>
      </div>
      {collapsed ? null : (
        <div className="ws-onb-list">
          {steps.map((step) => (
            <div className="ws-onb-li" data-done={step.done ? 'true' : 'false'} key={step.id}>
              {/* Dashed for "not yet", solid for done — the reference's own
                  distinction, and a clearer one than two shades of one ring. */}
              {step.done ? <CircleCheck size={15} /> : <CircleDashed size={15} />}
              {step.to && !step.done ? (
                <button type="button" className="ws-onb-go" onClick={() => onGo(step.to!)}>{step.label}</button>
              ) : (
                <span>{step.label}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
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
