/**
 * The Settings takeover.
 *
 * A full page rather than a section of the app, which is the whole reason it
 * exists. Divo's configuration is large — connections, per-action policy,
 * departments, skills, guardrails — and hanging all of it off the app
 * sidebar meant a member's nav was mostly rows a member cannot use. The
 * work surface keeps the composer, the conversations you have had and Mail;
 * everything you set up lives here behind one door.
 *
 * The rail's groups are the scopes this session actually holds. A member sees
 * Account and Agent and nothing else — not a greyed-out Company group, which
 * would advertise a place they may not go. Same `scopes` array that drives the
 * app's switcher, so there is no second opinion about who may see what.
 */
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Bot, Brain, Building2, Gauge, Library, Link2,
  ShieldCheck, SlidersHorizontal, UserSquare, Users, type LucideIcon,
} from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useManagedDepartments } from '@/pages/workspace/data/use-team'
import { RoleProvider } from '@/cursor/role-context'
import '@/styles/workspace.css'

export type RailItem = { to: string; label: string; icon: LucideIcon }
export type RailGroup = { label: string; scope: 'you' | 'team' | 'company'; items: RailItem[] }

/* Exported so the app's ⌘K palette can offer settings destinations too. Without
   it the palette only knew the three work routes and stopped being worth opening. */
export const RAIL: RailGroup[] = [
  {
    label: 'Account',
    scope: 'you',
    items: [
      { to: '/settings/profile', label: 'Profile', icon: UserSquare },
      { to: '/settings/preferences', label: 'Preferences', icon: SlidersHorizontal },
      { to: '/settings/connections', label: 'Connected apps', icon: Link2 },
      { to: '/settings/usage', label: 'Your usage', icon: Gauge },
      /* Memory was the last of the 'Agent' group once Access, Skills and
         Models were retired, and a heading over one row reads as a mistake.
         It is a thing about you, so it sits with the rest of them. */
      { to: '/settings/memory', label: 'Memory', icon: Brain },
    ],
  },
  {
    label: 'Your team',
    scope: 'team',
    items: [
      { to: '/settings/team/people', label: 'People', icon: Users },
      { to: '/settings/team/roles', label: 'Roles', icon: UserSquare },
      { to: '/settings/team/approvals', label: 'Ask me first', icon: ShieldCheck },
      /* "Team usage", not "Usage". The rail carried the word twice — once under
         Account for your own spend and once here for the team's — so the two
         were told apart only by which heading you had scrolled past. This is
         also the title of the page it opens, which is how somebody confirms
         they landed where they meant to. */
      { to: '/settings/team/usage', label: 'Team usage', icon: Gauge },
    ],
  },
  {
    label: 'Company',
    scope: 'company',
    items: [
      { to: '/settings/company/people', label: 'Members', icon: Users },
      { to: '/settings/company/departments', label: 'Departments', icon: Building2 },
      { to: '/settings/company/skills', label: 'Skills', icon: Library },
      { to: '/settings/company/memory', label: 'Memory', icon: Brain },
      { to: '/settings/company/guardrails', label: 'Guardrails', icon: Bot },
    ],
  },
]

/**
 * Which team the "Your team" pages are about.
 *
 * A person can lead more than one department, and every rail link points at
 * the same `/settings/team/*` — the department rides in a remembered selection
 * instead. In the app that selection is changed from the scope switcher, and
 * the takeover has no scope switcher, so without this a manager of two teams
 * could open Settings and had no way to reach the second one's people or
 * roles. Rendered only when there is genuinely a choice to make.
 */
function TeamPicker() {
  const { departments, department, select } = useManagedDepartments()
  if (departments.length < 2) return null

  return (
    <div className="set-picker">
      <select
        className="select"
        value={department?.id ?? ''}
        onChange={(e) => select(e.target.value)}
        aria-label="Which team these settings are about"
      >
        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </div>
  )
}

export function SettingsShell() {
  const { scopes } = useAdminAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const held = new Set(scopes.map((s) => s.kind))
  const groups = RAIL.filter((g) => held.has(g.scope))

  return (
    <RoleProvider>
      <div className="cur set">
        <aside className="set-rail">
          {/*
            Back goes to the app, not to history. Somebody who arrived here from
            a deep link has nothing sensible behind them, and a back button that
            sometimes leaves the app entirely is worse than one that always
            lands somewhere known.
          */}
          <button type="button" className="set-back" onClick={() => navigate('/me')}>
            <ArrowLeft size={15} /> Back to app
          </button>

          <nav className="set-rail-nav">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="nav-label">{group.label}</div>
                {group.scope === 'team' ? <TeamPicker /> : null}
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  >
                    <span className="g"><item.icon size={16} /></span>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* Keyed on the path so a new screen starts at its own top rather than
            inheriting the previous one's scroll offset. */}
        <div className="set-body" key={location.pathname}>
          <div className="set-col">
            <Outlet />
          </div>
        </div>
      </div>
    </RoleProvider>
  )
}
