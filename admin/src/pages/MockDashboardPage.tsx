/**
 * Divo Workspace — the role-aware web UI for members, managers and admins.
 *
 * ── Why the shell looks like this ──────────────────────
 * The old mock had a flat, admin-shaped nav. That breaks the moment a manager
 * signs in, because a manager is two people: an individual with their own
 * connections and spend, and a lead responsible for a team. A flat nav makes
 * "Connections" ambiguous — mine, or theirs?
 *
 * So scope is explicit and structural: You / Your team / Company. The nav
 * below it reshapes to the chosen scope. A member never sees the control at
 * all; they only ever have one scope, so no chrome hints at what they're
 * missing. One shell, one code path, no separate member app.
 *
 * ── What is fixture data ───────────────────────────────
 * All of it. Panels backed by endpoints that do not exist yet are marked in
 * the UI itself (see DATA_SOURCES in ./workspace/fixtures) rather than
 * quietly implying the backend is further along than it is.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Bell, Brain, Building2, Check, ChevronsUpDown, Diamond, Gauge,
  FileClock, FileStack, Grid2X2, KeyRound, Library, Link2, Moon, RotateCcw, Search, Settings, ShieldCheck,
  Sun, Users, UserSquare, type LucideIcon,
} from 'lucide-react'
import { useTheme } from '@/lib/use-theme'
import { AWAITING_ME, SCOPES, VIEWER, type Persona, type Scope } from './workspace/fixtures'
import { useToast } from './workspace/ui'
import {
  YouAccess, YouApprovals, YouConnections, YouHome, YouMemory, YouSettings, YouSkills, YouUsage,
} from './workspace/screens-you'
import {
  TeamApprovalPolicy, TeamHome, TeamPeople, TeamRoles, TeamUsage,
} from './workspace/screens-team'
import {
  CompanyAiOps, CompanyAudit, CompanyConnections, CompanyDepartments, CompanyGuardrails, CompanyHome,
  CompanyMemory, CompanyPeople, CompanyPolicy, CompanySkills,
} from './workspace/screens-company'
import { ConnectFlow } from './workspace/screens-connect'
import { Artifacts } from './workspace/screens-artifacts'
import {
  CompanyDepartmentDetail, CompanyPersonDetail, CompanyRunDetail, CompanySkillDetail,
} from './workspace/screens-company-detail'
import '@/styles/cursor.css'
import '@/styles/workspace.css'

type NavItem = { id: string; label: string; icon: LucideIcon; count?: number }
type NavGroup = { label?: string; items: NavItem[] }

const NAV: Record<Scope['kind'], NavGroup[]> = {
  you: [
    {
      items: [
        { id: 'home', label: 'Home', icon: Grid2X2 },
        { id: 'approvals', label: 'Approvals', icon: ShieldCheck, count: AWAITING_ME.length },
      ],
    },
    {
      label: 'Your setup',
      items: [
        { id: 'artifacts', label: 'Things Divo made', icon: FileStack },
        { id: 'connections', label: 'Connected apps', icon: Link2 },
        { id: 'access', label: 'What Divo can do', icon: KeyRound },
        { id: 'skills', label: 'Skills', icon: Library },
        { id: 'memory', label: 'Memory', icon: Brain },
      ],
    },
    {
      label: 'Account',
      items: [
        { id: 'usage', label: 'Usage', icon: Gauge },
        { id: 'settings', label: 'Settings', icon: Settings },
      ],
    },
  ],
  team: [
    {
      items: [
        { id: 'team-home', label: 'Overview', icon: Grid2X2 },
        { id: 'team-people', label: 'People', icon: Users },
      ],
    },
    {
      label: 'Access',
      items: [
        { id: 'team-roles', label: 'Roles', icon: UserSquare },
        { id: 'team-approvals', label: 'Ask me first', icon: ShieldCheck },
      ],
    },
    { label: 'Account', items: [{ id: 'team-usage', label: 'Usage', icon: Gauge }] },
  ],
  company: [
    {
      items: [
        { id: 'co-home', label: 'Overview', icon: Grid2X2 },
        { id: 'co-people', label: 'Everyone', icon: Users },
        { id: 'co-departments', label: 'Departments', icon: Building2 },
      ],
    },
    {
      label: 'Operations',
      items: [
        { id: 'co-aiops', label: 'AI Ops', icon: Activity },
        { id: 'co-skills', label: 'Skills', icon: Library },
        { id: 'co-memory', label: 'Memory', icon: Brain },
      ],
    },
    {
      label: 'Governance',
      items: [
        { id: 'co-policy', label: 'Company ceiling', icon: KeyRound },
        { id: 'co-connections', label: 'Connections', icon: Link2 },
        { id: 'co-guardrails', label: 'Guardrails', icon: Gauge },
        { id: 'co-audit', label: 'Activity', icon: FileClock },
      ],
    },
  ],
}

const TITLES: Record<string, string> = {
  home: 'Home', approvals: 'Approvals', connections: 'Connected apps', access: 'What Divo can do',
  skills: 'Skills', memory: 'Memory', usage: 'Usage', settings: 'Settings',
  'connect-flow': 'Connecting from Lark', artifacts: 'Things Divo made',
  'team-home': 'Overview', 'team-people': 'People', 'team-roles': 'Roles',
  'team-approvals': 'Ask me first', 'team-usage': 'Usage',
  'co-home': 'Overview', 'co-people': 'Everyone', 'co-departments': 'Departments',
  'co-policy': 'Company ceiling', 'co-connections': 'Connections', 'co-audit': 'Activity',
  'co-aiops': 'AI Ops', 'co-skills': 'Skills', 'co-memory': 'Memory', 'co-guardrails': 'Guardrails',
  'co-run': 'Run', 'co-person': 'Person', 'co-department': 'Department', 'co-skill': 'Skill',
}

const FIRST_SCREEN: Record<Scope['kind'], string> = { you: 'home', team: 'team-home', company: 'co-home' }

export function MockDashboardPage() {
  const [persona, setPersona] = useState<Persona>('manager')
  const scopes = SCOPES[persona]
  const [scopeId, setScopeId] = useState<string>(scopes[0].id)
  const [screen, setScreen] = useState('home')
  const [scopeOpen, setScopeOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  const [replay, setReplay] = useState(0)
  const { resolved, setTheme } = useTheme()
  const { message, show } = useToast()

  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0]
  const groups = NAV[scope.kind]
  const viewer = VIEWER[persona]

  // Switching persona re-seats the viewer entirely: new scopes, new landing screen.
  const switchPersona = (next: Persona) => {
    setPersona(next)
    const nextScope = SCOPES[next][0]
    setScopeId(nextScope.id)
    setScreen(FIRST_SCREEN[nextScope.kind])
    setReplay((n) => n + 1)
    setScopeOpen(false)
  }

  const switchScope = (next: Scope) => {
    setScopeId(next.id)
    setScreen(FIRST_SCREEN[next.kind])
    setScopeOpen(false)
    setReplay((n) => n + 1)
  }

  const go = (next: string) => { setScreen(next); setReplay((n) => n + 1) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="cur app">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark"><Diamond size={13} fill="currentColor" /></span>
          <b>Divo</b>
        </div>

        <ScopeSwitcher
          scope={scope}
          scopes={scopes}
          open={scopeOpen}
          onOpen={() => setScopeOpen((v) => !v)}
          onPick={switchScope}
        />

        <nav className="ws-nav">
          {groups.map((group, gi) => (
            <div key={gi}>
              {group.label ? <div className="nav-label">{group.label}</div> : <div style={{ height: 8 }} />}
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`nav-item${screen === item.id ? ' active' : ''}`}
                  style={{ width: '100%', border: 0, background: screen === item.id ? undefined : 'none' }}
                  onClick={() => go(item.id)}
                >
                  <span className="g"><item.icon size={16} /></span>
                  {item.label}
                  {item.count ? <span className="ws-nav-count">{item.count}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button type="button" className="ws-acct" onClick={() => go(scope.kind === 'you' ? 'settings' : FIRST_SCREEN[scope.kind])}>
            <span className="avatar">{viewer.initials}</span>
            <span className="ws-acct-txt">
              <b>{viewer.name}</b>
              <span>{viewer.role}</span>
            </span>
          </button>
        </div>
      </aside>

      <div className="shell">
        <header className="topbar">
          <div className="ws-crumb">
            <button type="button" onClick={() => go(FIRST_SCREEN[scope.kind])}>{scope.label}</button>
            <span>/</span>
            <b>{TITLES[screen] ?? 'Home'}</b>
          </div>

          <button type="button" className="search" onClick={() => setPalette(true)} style={{ maxWidth: 240, cursor: 'pointer' }}>
            <Search size={14} />
            <span style={{ flex: 1, textAlign: 'left' }}>Search</span>
            <span className="ws-kbd">⌘K</span>
          </button>

          <button type="button" className="icon-btn" title="Replay the loading sequence" onClick={() => setReplay((n) => n + 1)}>
            <RotateCcw size={15} />
          </button>

          <button
            type="button"
            className="icon-btn"
            title={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
          >
            {resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>

          <button type="button" className="icon-btn" style={{ position: 'relative' }} title="Notifications">
            <Bell size={15} />
            {AWAITING_ME.length ? <span className="ws-dot-alert" /> : null}
          </button>

          {/* Mock-only control. Not part of the product — it exists so all three
              audiences can be compared without three separate sign-ins. */}
          <PersonaSwitch persona={persona} onChange={switchPersona} />
        </header>

        <div className="content">
          <div className="scroll">
            <div className="page">
              <Screen screen={screen} persona={persona} replay={replay} toast={show} go={go} />
            </div>
          </div>
        </div>
      </div>

      {palette ? (
        <CommandPalette groups={groups} onClose={() => setPalette(false)} onPick={(id) => { go(id); setPalette(false) }} />
      ) : null}

      {message ? <div className="ws-toast"><Check size={14} />{message}</div> : null}
    </div>
  )
}

/* ── Scope switcher ───────────────────────────────────
   A member has exactly one scope, so the control renders as a static label
   with no affordance — nothing suggests a door they cannot open. */
function ScopeSwitcher({ scope, scopes, open, onOpen, onPick }: {
  scope: Scope; scopes: Scope[]; open: boolean; onOpen: () => void; onPick: (s: Scope) => void
}) {
  const single = scopes.length === 1
  const Icon = scope.kind === 'you' ? UserSquare : scope.kind === 'team' ? Users : Building2
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOpen() }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onOpen])

  return (
    <div className="ws-scope" ref={ref}>
      <button
        type="button"
        className={`ws-scope-btn${open ? ' open' : ''}`}
        data-static={single}
        onClick={single ? undefined : onOpen}
      >
        <span className="ws-scope-ic" data-tone={single ? 'ink' : undefined}><Icon size={14} /></span>
        <span className="ws-scope-txt">
          <b>{scope.label}</b>
          <span>{scope.detail}</span>
        </span>
        {!single ? <ChevronsUpDown size={14} className="muted" /> : null}
      </button>

      {open && !single ? (
        <div className="ws-scope-menu">
          <div className="ws-scope-group">You</div>
          {scopes.filter((s) => s.kind === 'you').map((s) => (
            <ScopeOption key={s.id} scope={s} active={s.id === scope.id} onPick={onPick} />
          ))}
          {scopes.some((s) => s.kind === 'team') ? (
            <>
              <div className="ws-scope-group">Teams you lead</div>
              {scopes.filter((s) => s.kind === 'team').map((s) => (
                <ScopeOption key={s.id} scope={s} active={s.id === scope.id} onPick={onPick} />
              ))}
            </>
          ) : null}
          {scopes.some((s) => s.kind === 'company') ? (
            <>
              <div className="ws-scope-group">Company</div>
              {scopes.filter((s) => s.kind === 'company').map((s) => (
                <ScopeOption key={s.id} scope={s} active={s.id === scope.id} onPick={onPick} />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ScopeOption({ scope, active, onPick }: { scope: Scope; active: boolean; onPick: (s: Scope) => void }) {
  const Icon = scope.kind === 'you' ? UserSquare : scope.kind === 'team' ? Users : Building2
  return (
    <button type="button" className="ws-scope-opt" onClick={() => onPick(scope)}>
      <span className="ws-scope-ic"><Icon size={13} /></span>
      <span className="ws-scope-txt">
        <b>{scope.label}</b>
        <span>{scope.detail}</span>
      </span>
      {active ? <Check size={14} className="ck" /> : null}
    </button>
  )
}

/* ── Persona switch — mock scaffolding only ──────────── */
function PersonaSwitch({ persona, onChange }: { persona: Persona; onChange: (p: Persona) => void }) {
  return (
    <div className="ws-seg" title="Mock control — preview each audience">
      {(['member', 'manager', 'admin'] as Persona[]).map((p) => (
        <button key={p} type="button" className={p === persona ? 'on' : ''} onClick={() => onChange(p)}>
          {p === 'member' ? 'Member' : p === 'manager' ? 'Manager' : 'Admin'}
        </button>
      ))}
    </div>
  )
}

/* ── Command palette ─────────────────────────────────── */
function CommandPalette({ groups, onClose, onPick }: {
  groups: NavGroup[]; onClose: () => void; onPick: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const results = useMemo(() => flat.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [flat, q])

  useEffect(() => setCursor(0), [q])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
      if (e.key === 'Enter' && results[cursor]) onPick(results[cursor].id)
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
                key={r.id}
                className={`ws-pal-i${i === cursor ? ' on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onPick(r.id)}
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

/* ── Router ──────────────────────────────────────────── */
function Screen(props: { screen: string; persona: Persona; replay: number; toast: (m: string) => void; go: (s: string) => void }) {
  const { screen, ...rest } = props
  switch (screen) {
    case 'home': return <YouHome {...rest} />
    case 'approvals': return <YouApprovals {...rest} />
    case 'connections': return <YouConnections {...rest} />
    case 'connect-flow': return <ConnectFlow {...rest} />
    case 'artifacts': return <Artifacts {...rest} />
    case 'access': return <YouAccess {...rest} />
    case 'skills': return <YouSkills {...rest} />
    case 'memory': return <YouMemory {...rest} />
    case 'usage': return <YouUsage {...rest} />
    case 'settings': return <YouSettings {...rest} />
    case 'team-home': return <TeamHome {...rest} />
    case 'team-people': return <TeamPeople {...rest} />
    case 'team-roles': return <TeamRoles {...rest} />
    case 'team-approvals': return <TeamApprovalPolicy {...rest} />
    case 'team-usage': return <TeamUsage {...rest} />
    case 'co-home': return <CompanyHome {...rest} />
    case 'co-people': return <CompanyPeople {...rest} />
    case 'co-departments': return <CompanyDepartments {...rest} />
    case 'co-policy': return <CompanyPolicy {...rest} />
    case 'co-connections': return <CompanyConnections {...rest} />
    case 'co-audit': return <CompanyAudit {...rest} />
    case 'co-aiops': return <CompanyAiOps {...rest} />
    case 'co-skills': return <CompanySkills {...rest} />
    case 'co-memory': return <CompanyMemory {...rest} />
    case 'co-guardrails': return <CompanyGuardrails {...rest} />
    case 'co-run': return <CompanyRunDetail {...rest} />
    case 'co-person': return <CompanyPersonDetail {...rest} />
    case 'co-department': return <CompanyDepartmentDetail {...rest} />
    case 'co-skill': return <CompanySkillDetail {...rest} />
    default: return <YouHome {...rest} />
  }
}

export default MockDashboardPage
