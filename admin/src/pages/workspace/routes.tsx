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
import { notify } from '@/lib/notify'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import type { Persona } from './fixtures'
import type { Toast } from './ui'

/** Screen ids used inside the screens map onto real paths here. */
const PATHS: Record<string, string> = {
  /* Work — the app shell. */
  home: '/',
  chat: '/chat',
  'mail-rules': '/me/mail',
  /* Retired — the real artifacts are read from the chat panel and Home's
     "Made" band. Any caller still naming this lands on Home. */
  artifacts: '/',
  /* Retired: no HTTP route reaches scheduled workflows, and the backend
     refuses to create one from the web channel at all. The drill-in key goes
     rather than being pointed at Home — it appends an id, so a retired one
     would resolve to `/<id>` instead of falling through to the default. */
  automations: '/',
  'team-home': '/team',
  'co-home': '/home',
  'co-aiops': '/ai-ops',
  'co-agents': '/agents',
  'co-audit': '/activity',

  /* Configuration — the Settings takeover. */
  connections: '/settings/connections',
  'connect-flow': '/settings/connections/lark-flow',
  /* Retired screens. The keys stay so any caller still naming one lands on
     Connected apps rather than falling through to the `/` default, which is
     how a button once quietly took a manager to their own home page. */
  access: '/settings/connections',
  skills: '/settings/connections',
  memory: '/settings/memory',
  usage: '/settings/usage',
  settings: '/settings/profile',
  'team-people': '/settings/team/people',
  /* TeamHome's "Manage" button passes `people`, not `team-people`. There has
     never been an entry for it, so `resolvePath` fell through to its `/`
     default and the button quietly took a manager to their own home page. */
  people: '/settings/team/people',
  'team-roles': '/settings/team/roles',
  /* Points at the new home directly rather than at the redirect, so a
     caller does not pay a second navigation to land in the same place. */
  'team-approvals': '/settings/approvals',
  /* One page for both keys. A decision raised in a thread is answered in that
     thread; this is the page that says what will stop and ask, which is the
     only thing "approvals" can usefully mean as a destination. */
  approvals: '/settings/approvals',
  'team-usage': '/settings/team/usage',
  'co-people': '/settings/company/people',
  'co-departments': '/settings/company/departments',
  'co-skills': '/settings/company/skills',
  'co-memory': '/settings/company/memory',
  'co-guardrails': '/settings/company/guardrails',
  /* The company ceiling and the company connections page are both retired.
     Their two live parts survived the removal: the shared web-search key moved
     under Connected apps, which is where the rest of what Divo can reach is
     read, and the company-held Airtable and AITable tokens are connected from
     the cards there. */
  'co-policy': '/settings/company/people',
  'co-connections': '/settings/connections',
  'web-search': '/settings/connections/web-search',
  'co-web-search': '/settings/connections/web-search',
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
  if (!key) return '/'
  const base = PATHS[key]
  if (!base) return '/'
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
 *
 * `full` opts a screen out of the `.page` box — the padded, max-width,
 * height-less container every other screen wants. A chat surface wants the
 * opposite of all three: it runs to the edges, it owns the full height, and it
 * scrolls its own thread rather than the shell scrolling the whole document.
 * Left in `.page` it renders as a short card floating in an empty column.
 */
export function routed(Screen: ComponentType<ScreenProps>, { full = false } = {}) {
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
      <div className={full ? 'page-full' : 'page'}>
        <Screen
          persona={persona}
          replay={replay}
          /*
           * A failed write must not look like a completed one. Every screen
           * toasted through `sonner.success`, so "Could not save that key"
           * arrived green with a checkmark next to it — the one moment the
           * interface has to be believed, spent saying the opposite.
           *
           * Through `notify` rather than sonner directly, so this shim — which
           * is what most of the workspace still speaks through — gets the same
           * durations as everything else, and the same collapsing of repeats.
           * Left as a shim on purpose: screens hand over a sentence and a tone,
           * and the four intents are a judgement those call sites have not made
           * yet.
           */
          toast={(m, tone) => (tone === 'error' ? notify.failed(m) : notify.done(m))}
          go={(screen) => navigate(resolvePath(screen))}
        />
      </div>
    )
  }
}
