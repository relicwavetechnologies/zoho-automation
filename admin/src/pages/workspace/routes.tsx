/**
 * Router adapters for the Workspace screens.
 *
 * The screens were written for the standalone mock, where navigation was local
 * state and `go(screenId)` switched it. Routed into the real app they need the
 * same contract backed by the router instead, so the screens themselves stay
 * untouched and keep working in both places — the `/mock-dashboard` preview
 * (all three personas, one page) and the real app (one persona, real URLs).
 *
 * `replay` re-runs the staged loading sequence. In the real app it advances on
 * mount so each navigation plays its skeletons once, the same as a real fetch.
 */
import { useEffect, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast as sonner } from 'sonner'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import type { Persona } from './fixtures'

/** Screen ids used inside the screens map onto real paths here. */
const PATHS: Record<string, string> = {
  home: '/me',
  approvals: '/me/approvals',
  artifacts: '/me/artifacts',
  connections: '/me/connections',
  'connect-flow': '/me/connections/lark-flow',
  access: '/me/access',
  skills: '/me/skills',
  memory: '/me/memory',
  usage: '/me/usage',
  settings: '/me/settings',
  'team-home': '/team',
  'team-people': '/team/people',
  'team-roles': '/team/roles',
  'team-approvals': '/team/approvals',
  'team-usage': '/team/usage',
  'co-home': '/home',
  'co-people': '/people',
  'co-departments': '/departments',
  'co-policy': '/policy',
  'co-connections': '/connections',
  'co-audit': '/activity',
  'co-aiops': '/ai-ops',
  'co-skills': '/skills',
  'co-memory': '/memories',
  'co-guardrails': '/guardrails',
  /* Drill-ins. The mock's detail screens map onto the live pages' list routes
     until those pages are ported — a routed screen must never resolve to `/me`
     just because an id is missing here. */
  'co-run': '/ai-ops',
  'co-person': '/people',
  'co-department': '/departments',
  'co-skill': '/skills',
}

type ScreenProps = {
  persona: Persona
  replay: number
  toast: (m: string) => void
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
          toast={(m) => sonner.success(m)}
          go={(screen) => navigate(PATHS[screen] ?? '/me')}
        />
      </div>
    )
  }
}
