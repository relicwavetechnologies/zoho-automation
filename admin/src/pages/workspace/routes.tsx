/**
 * Router adapters for the Workspace screens.
 *
 * The screens were written for a standalone mock, where navigation was local
 * state and `go(screenId)` switched it. They are the real app now, so the same
 * contract is backed by the router instead — which kept the port to real data a
 * re-skin rather than a rewrite.
 *
 * `replay` re-runs the staged loading sequence. In the real app it advances on
 * mount so each navigation plays its skeletons once, the same as a real fetch.
 */
import { useEffect, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast as sonner } from 'sonner'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import type { Persona } from './fixtures'
import type { Toast } from './ui'

/** Screen ids used inside the screens map onto real paths here. */
const PATHS: Record<string, string> = {
  /* Work — the app shell. */
  home: '/me',
  'mail-rules': '/me/mail',
  approvals: '/me/approvals',
  artifacts: '/me/artifacts',
  automations: '/me/automations',
  /* Drill-in: a screen passes `automation:<id>`. */
  automation: '/me/automations',
  'team-home': '/team',
  'co-home': '/home',
  'co-aiops': '/ai-ops',
  'co-agents': '/agents',
  'co-audit': '/activity',

  /* Configuration — the Settings takeover. */
  connections: '/settings/connections',
  'connect-flow': '/settings/connections/lark-flow',
  access: '/settings/access',
  skills: '/settings/skills',
  memory: '/settings/memory',
  usage: '/settings/usage',
  settings: '/settings/profile',
  'team-people': '/settings/team/people',
  /* TeamHome's "Manage" button passes `people`, not `team-people`. There has
     never been an entry for it, so `resolvePath` fell through to its `/me`
     default and the button quietly took a manager to their own home page. */
  people: '/settings/team/people',
  'team-roles': '/settings/team/roles',
  'team-approvals': '/settings/team/approvals',
  'team-usage': '/settings/team/usage',
  'co-people': '/settings/company/people',
  'co-departments': '/settings/company/departments',
  'co-policy': '/settings/company/policy',
  'co-connections': '/settings/company/connections',
  'co-skills': '/settings/company/skills',
  'co-memory': '/settings/company/memory',
  'co-guardrails': '/settings/company/guardrails',
  'co-web-search': '/settings/company/connections/web-search',
  /* Drill-ins. A screen passes `co-run:<id>`; the id is appended to the base
     path below. Without one it lands on the list, which is a worse answer than
     the detail but never a wrong one. */
  'co-run': '/ai-ops/runs',
  'co-person': '/settings/company/people',
  'co-department': '/settings/company/departments',
  'co-skill': '/settings/company/skills',
}

/** Falls back to the list route when a screen passes no id. */
const LIST_FALLBACK: Record<string, string> = {
  automation: '/me/automations',
  'co-run': '/ai-ops',
  'co-person': '/settings/company/people',
  'co-department': '/settings/company/departments',
  'co-skill': '/settings/company/skills',
}

/**
 * `go('co-run:abc')` → `/ai-ops/runs/abc`.
 *
 * The screens were written against opaque screen ids, so an id rides along
 * after a colon rather than the screens learning about the router.
 */
export function resolvePath(screen: string): string {
  const [key, id] = screen.split(':')
  if (!key) return '/me'
  const base = PATHS[key]
  if (!base) return '/me'
  if (!id) return LIST_FALLBACK[key] ?? base
  return `${base}/${id}`
}

type ScreenProps = {
  persona: Persona
  replay: number
  toast: Toast
  go: (screen: string) => void
}

/**
 * Wraps a Workspace screen so it can be used as a route element.
 * Screens that don't take `persona` simply ignore it.
 */
export function routed(Screen: ComponentType<ScreenProps>) {
  return function RoutedScreen() {
    const navigate = useNavigate()
    const { session } = useAdminAuth()
    const [replay, setReplay] = useState(0)

    // One staged-load pass per mount, so navigating somewhere plays its
    // skeletons rather than snapping in fully formed.
    useEffect(() => { setReplay((n) => n + 1) }, [])

    const persona: Persona =
      session?.role === 'SUPER_ADMIN' || session?.role === 'COMPANY_ADMIN' ? 'admin' : 'member'

    return (
      <div className="page">
        <Screen
          persona={persona}
          replay={replay}
          // A failed write must not look like a completed one. Every screen
          // toasted through `sonner.success`, so "Could not save that key"
          // arrived green with a checkmark next to it — the one moment the
          // interface has to be believed, spent saying the opposite.
          toast={(m, tone) => (tone === 'error' ? sonner.error(m) : sonner.success(m))}
          go={(screen) => navigate(resolvePath(screen))}
        />
      </div>
    )
  }
}
