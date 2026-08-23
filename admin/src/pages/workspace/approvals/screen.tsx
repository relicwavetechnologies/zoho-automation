/**
 * `/settings/approvals` — the one page that answers "will this stop and ask me?"
 *
 * Two rules, one on screen at a time. That was the whole lesson of the first
 * version, which drew both as pills on one row inside a department tab: a
 * personal, global setting wrapped in a per-team container, so ticking it
 * raised three questions nobody could answer from the screen. Did I cover one
 * team or all of them? Does a tool in two teams need ticking twice? Does the
 * pick hold when I ask from the other team?
 *
 * The answers are all, once, and yes. Now the layout says so, because the
 * personal view has no department anywhere in it:
 *
 *   Asks you   — yours, every team, no tabs. One row per action, once.
 *   Your teams — one department at a time, about everybody except its approver.
 *
 * Switched rather than stacked, so there is never a second scope on screen for
 * a control to borrow meaning from. The rows in the personal view come from a
 * flat catalogue the backend builds from static tables, not from any
 * department's permission matrix — deriving them per department is what created
 * the confusion in the first place.
 */
import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { api } from '@/lib/api'
import { notify } from '@/lib/notify'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { PageHeader, Skel } from './../ui'
import { useApprovalPolicy, useDepartmentMatrix } from '../data/use-team'
import { PersonalForecast, TeamForecast, type ForecastRow } from './forecast.view'
import type { GatePolicy } from './forecast'
import {
  NO_PERSONAL_GATE,
  personalGateSize,
  togglePersonalAction,
  type PersonalGate,
} from './personal-gate'
import { BRAND_CATALOG, type BrandKey } from '@/components/admin/brand-catalog'

type Department = {
  departmentId: string
  departmentName: string
  policy: GatePolicy | null
  askerIsApprover: boolean
  approverExists: boolean
  approverName: string | null
}

type CatalogueAction = {
  toolId: string
  action: string
  toolName: string
  actionLabel: string
  brand?: string
}

type Forecast = {
  actions: CatalogueAction[]
  departments: Department[]
  personal: PersonalGate
}

/** Which of the two rules is on screen. Never both at once. */
type Scope = 'personal' | 'teams'

const BASE_DESCRIPTION =
  'What happens when you ask Divo to do each of these. Reading is never gated.'

/** Only brands the catalog actually knows how to draw. */
function brandOf(action: CatalogueAction): BrandKey | undefined {
  return action.brand && action.brand in BRAND_CATALOG ? action.brand as BrandKey : undefined
}

function toRow(action: CatalogueAction): ForecastRow {
  const brand = brandOf(action)
  return {
    toolId: action.toolId,
    action: action.action,
    toolName: action.toolName,
    actionLabel: action.actionLabel,
    ...(brand ? { brand } : {}),
  }
}

export function ApprovalsScreen() {
  const { token } = useAdminAuth()
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [loading, setLoading] = useState(true)
  /* Kept apart from "loaded, and there is nothing". They rendered the same
     sentence, so a refused read told somebody their work was ungated. */
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  /* Personal first, because it is the one the reader owns and the one they are
     almost always here to check. The team rules are an occasional admin job. */
  const [scope, setScope] = useState<Scope>('personal')

  const load = async () => {
    if (!token) { setLoading(false); return }
    try {
      setForecast(await api.get<Forecast>('/api/desktop/me/approval-forecast', token, { raw: true }))
      setFailed(false)
    } catch {
      setForecast(null)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [token])

  const personal = forecast?.personal ?? NO_PERSONAL_GATE

  /*
   * Saved optimistically, then corrected by what came back. Every pill redraws
   * from this one value, so waiting for the round trip would leave a row you
   * just clicked showing the old answer.
   */
  const savePersonal = async (next: PersonalGate) => {
    if (!token || !forecast) return
    const previous = forecast.personal
    setForecast({ ...forecast, personal: next })
    try {
      const saved = await api.put<{ personal: PersonalGate }>(
        '/api/desktop/me/personal-approvals', next, token, { raw: true },
      )
      setForecast((current) => (current ? { ...current, personal: saved.personal } : current))
    } catch (e) {
      setForecast((current) => (current ? { ...current, personal: previous } : current))
      notify.failed('That was not saved', e instanceof Error ? e.message : null)
    }
  }

  if (loading) return <ApprovalsSkeleton />

  if (failed) {
    return (
      <>
        <PageHeader title="What needs a yes" description={BASE_DESCRIPTION} />
        <div className="rounded-card bg-surface px-4 py-3 shadow-card">
          <p className="text-[13px] font-medium leading-tight text-ink">Could not read your rules</p>
          <p className="mt-1 text-[11.5px] leading-snug text-ink-3">
            This says nothing about what is gated. Nothing has changed, and no
            answer here would be a real one.
          </p>
          <button
            type="button"
            onClick={() => { setLoading(true); void load() }}
            className="mt-2.5 rounded-chip px-2.5 py-1.5 text-[11.5px] font-medium leading-none"
            style={{ background: 'var(--bui-ink)', color: 'var(--bui-surface)' }}
          >
            Try again
          </button>
        </div>
      </>
    )
  }

  if (!forecast) return <ApprovalsSkeleton />

  const rows = forecast.actions.map(toRow)
  const departments = forecast.departments
  const shown = departments.find((d) => d.departmentId === selected) ?? departments[0]

  /* The reader's own answer is computed against the team they are looking at,
     because a team gate is what makes a row read "Asks your manager" for a
     member. Their own picks do not care which team is on screen. */
  const asPersonal = {
    rows,
    query,
    policy: shown?.policy ?? null,
    channel: 'web' as const,
    askerIsApprover: shown?.askerIsApprover ?? false,
    selfBypassDisabled: false,
    approverExists: shown?.approverExists ?? false,
    personal,
    ...(shown?.approverName ? { approverName: shown.approverName } : {}),
  }

  return (
    <>
      <PageHeader title="What needs a yes" description={BASE_DESCRIPTION} />
      <div className="ws-stack">
        <ScopeSwitch
          scope={scope}
          onScope={setScope}
          teams={departments.length}
          note={scope === 'personal'
            ? 'Applies wherever you ask Divo, in every team you are in. Nobody else is affected, and there is no team to choose.'
            : shown?.askerIsApprover
              ? 'Approval gates for everybody else in the team. You are the one asked, so they never stop you.'
              : 'Actions your manager is asked about before Divo runs them for you.'}
        />

        {scope === 'personal' ? (
          <>
            <Controls
              query={query}
              onQuery={setQuery}
              personal={personal}
              onEverything={(all) => void savePersonal({ ...personal, all })}
            />
            <PersonalForecast
              {...asPersonal}
              onToggle={(toolId, action) =>
                void savePersonal(togglePersonalAction(personal, toolId, action))}
            />
          </>
        ) : shown ? (
          <>
            {departments.length > 1 ? (
              <DepartmentSwitch
                departments={departments}
                selected={shown.departmentId}
                onSelect={setSelected}
              />
            ) : (
              <p className="px-1 text-[12px] font-medium text-ink">{shown.departmentName}</p>
            )}
            <TeamSection department={shown} query={query} personal={personal} onSaved={load} />
          </>
        ) : (
          <p className="rounded-card bg-surface px-4 py-3 text-[12px] leading-snug text-ink-3 shadow-card">
            You are not in a department yet, so no team gates apply to you.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * Which of the two rules you are looking at.
 *
 * The switch is the fix. Both lists used to sit stacked on one page, and a
 * personal list that runs to seventy rows pushed the team list so far down that
 * the two read as one long thing with an arbitrary divider. Worse, stacking put
 * a team tab and a personal pill on screen together, which is the exact
 * ambiguity this rebuild exists to remove: one scope visible at a time means
 * there is never a second scope nearby to borrow meaning from.
 *
 * The chip on each tab repeats the scope in three words, because the tab label
 * alone ("Asks you") says who is affected but not how far it reaches.
 */
function ScopeSwitch({
  scope, onScope, teams, note,
}: {
  scope: Scope
  onScope: (next: Scope) => void
  teams: number
  note: string
}) {
  const tabs: { key: Scope; label: string; chip: string }[] = [
    { key: 'personal', label: 'Asks you', chip: 'yours · every team' },
    { key: 'teams', label: 'Your teams', chip: teams > 1 ? `${teams} teams · other people` : 'per team · other people' },
  ]
  return (
    <div>
      <div role="tablist" aria-label="Whose rules" className="flex flex-wrap gap-1">
        {tabs.map((tab) => {
          const on = tab.key === scope
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onScope(tab.key)}
              className="flex items-center gap-2 rounded-chip px-3 py-2 text-[12.5px] font-medium leading-none transition-colors duration-150"
              style={on
                ? { background: 'var(--bui-ink)', color: 'var(--bui-surface)' }
                : { background: 'var(--bui-surface)', color: 'var(--bui-ink-2)' }}
            >
              {tab.label}
              <span
                className="rounded-chip px-1.5 py-0.5 text-[10.5px] font-normal leading-tight"
                style={on
                  ? { background: 'rgb(255 255 255 / 0.16)', color: 'var(--bui-surface)' }
                  : { background: 'var(--bui-fill)', color: 'var(--bui-ink-3)' }}
              >
                {tab.chip}
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 px-1 text-[11.5px] leading-snug text-ink-3">{note}</p>
    </div>
  )
}

/**
 * The filter, and the one personal setting that is not a row.
 *
 * "Ask me about everything" stays small and to one side. It used to be the only
 * personal control there was, which made the offer "no interruptions or all of
 * them" — so everybody chose none. The real answer is picking four actions on
 * the rows below.
 */
function Controls({
  query, onQuery, personal, onEverything,
}: {
  query: string
  onQuery: (next: string) => void
  personal: PersonalGate
  onEverything: (all: boolean) => void
}) {
  const picked = personalGateSize(personal)
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface px-4 py-2.5 shadow-card">
      <div className="flex min-w-[180px] flex-1 items-center gap-2">
        <Search size={14} aria-hidden className="shrink-0 text-ink-3" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter by tool or action"
          aria-label="Filter by tool or action"
          className="w-full bg-transparent text-[12.5px] leading-tight text-ink outline-none placeholder:text-ink-3"
        />
      </div>

      <p className="text-[11.5px] leading-tight text-ink-3">
        {personal.all
          ? 'Everything asks you'
          : picked === 0
            ? 'Nothing asks you yet'
            : `${picked} ${picked === 1 ? 'action asks' : 'actions ask'} you`}
      </p>

      <button
        type="button"
        role="switch"
        aria-checked={personal.all}
        aria-label="Ask me about everything"
        title="Confirm every action, including on tools added later"
        onClick={() => onEverything(!personal.all)}
        className="flex items-center gap-2 rounded-chip px-2 py-1 text-[11px] font-medium leading-none text-ink-2 hover:bg-fill"
      >
        Ask me about everything
        <span
          className="relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-200"
          style={{ background: personal.all ? 'var(--bui-ink)' : 'var(--bui-line-strong)' }}
        >
          <span
            className="absolute top-[3px] size-3 rounded-full bg-surface transition-[left] duration-200"
            style={{ left: personal.all ? 15 : 3 }}
          />
        </span>
      </button>
    </div>
  )
}

/**
 * Which team's rules you are reading.
 *
 * Inside the team zone, where it belongs. It used to sit above everything and
 * scope the personal pills too, which is the bug this rebuild exists for.
 */
function DepartmentSwitch({
  departments, selected, onSelect,
}: {
  departments: Department[]
  selected: string
  onSelect: (departmentId: string) => void
}) {
  return (
    <div role="tablist" aria-label="Team" className="flex flex-wrap gap-1">
      {departments.map((department) => {
        const on = department.departmentId === selected
        return (
          <button
            key={department.departmentId}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(department.departmentId)}
            className="rounded-chip px-2.5 py-1.5 text-[12px] font-medium leading-none transition-colors duration-150"
            style={on
              ? { background: 'var(--bui-ink)', color: 'var(--bui-surface)' }
              : { background: 'var(--bui-surface)', color: 'var(--bui-ink-2)' }}
          >
            {department.departmentName}
            <span className="ml-1.5 font-normal" style={{ opacity: 0.65 }}>
              {department.askerIsApprover ? 'you approve' : 'member'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function TeamSection({
  department, query, personal, onSaved,
}: {
  department: Department
  query: string
  personal: PersonalGate
  onSaved: () => Promise<void>
}) {
  const matrix = useDepartmentMatrix(department.departmentId)
  const { policy, save } = useApprovalPolicy(
    department.askerIsApprover ? department.departmentId : undefined,
  )

  /*
   * Rows come from the policy first, the tool matrix second.
   *
   * The team zone is genuinely per department, so it does use the matrix. Built
   * this way round because the matrix is several round trips and can fail:
   * deriving every row from it meant a slow read rendered an empty list under
   * the words "this team gates nothing".
   */
  const seen = new Set<string>()
  const rows: ForecastRow[] = []
  const names = new Map(matrix.tools.map((t) => [t.tool.toolId, t.tool.name || t.tool.toolId]))
  const labels = new Map(matrix.tools.map((t) => [t.tool.toolId, t.actionLabels ?? {}]))
  const push = (toolId: string, action: string) => {
    const key = `${toolId}:${action}`
    if (seen.has(key) || action === 'read') return
    seen.add(key)
    rows.push({
      toolId,
      action,
      toolName: names.get(toolId) ?? toolId,
      actionLabel: labels.get(toolId)?.[action] ?? action,
      ...(toolId in BRAND_CATALOG ? { brand: toolId as BrandKey } : {}),
    })
  }
  for (const entry of department.policy?.requiredActions ?? []) {
    for (const action of entry.actions) push(entry.toolId, action)
  }
  for (const tool of matrix.tools) {
    for (const action of tool.supportedActions) push(tool.tool.toolId, action)
  }

  /* Every write replaces the policy wholesale, the contract the route has. */
  const onToggle = async (toolId: string, action: string) => {
    if (!department.askerIsApprover) return
    if (!policy) {
      notify.refused('Not loaded yet', 'The current policy has not arrived, so changing it would overwrite it.')
      return
    }
    const key = `${toolId}:${action}`
    const gated = new Set(policy.requiredActions.flatMap((e) => e.actions.map((a) => `${e.toolId}:${a}`)))
    if (gated.has(key)) gated.delete(key)
    else gated.add(key)

    const byTool = new Map<string, string[]>()
    for (const entry of gated) {
      const [id, act] = entry.split(':') as [string, string]
      byTool.set(id, [...(byTool.get(id) ?? []), act])
    }
    try {
      await save({
        enabled: gated.size > 0,
        requiredActions: [...byTool].map(([id, actions]) => ({ toolId: id, actions })),
      })
      await onSaved()
    } catch (e) {
      notify.failed('That was not saved', e instanceof Error ? e.message : null)
    }
  }

  return (
    <>
      {matrix.error ? (
        <p className="rounded-card bg-surface px-4 py-3 text-[12px] leading-snug text-ink-2 shadow-card">
          {matrix.error} Anything this team gates is still listed; the actions
          that run without asking are not.
        </p>
      ) : null}

      <TeamForecast
        rows={rows}
        loading={matrix.loading && rows.length === 0}
        query={query}
        policy={department.policy}
        channel="web"
        askerIsApprover={department.askerIsApprover}
        /* The browser cannot see the server's env, and guessing would make the
           page confidently wrong for the one person it matters to. */
        selfBypassDisabled={false}
        personal={personal}
        approverExists={department.approverExists}
        {...(department.approverName ? { approverName: department.approverName } : {})}
        {...(department.askerIsApprover ? { onToggle: (t: string, a: string) => void onToggle(t, a) } : {})}
      />
    </>
  )
}

/**
 * The page's own shape, before it knows anything.
 *
 * A title over an empty screen gave no sense of what was coming or how much of
 * it, so a slow read looked like a broken page.
 */
export function ApprovalsSkeleton() {
  return (
    <>
      <PageHeader title="What needs a yes" description={BASE_DESCRIPTION} />
      <div className="ws-stack" aria-busy="true" aria-label="Reading your rules">
        {[0, 1].map((zone) => (
          <div
            key={zone}
            className="rounded-card px-3 pb-3 pt-3"
            style={{ background: 'var(--bui-fill)', border: '1px solid var(--bui-line)' }}
          >
            <div className="mb-2 px-1">
              <Skel w={zone === 0 ? 96 : 112} h={13} />
              <div style={{ height: 7 }} />
              <Skel w="72%" h={9} />
            </div>
            <div className="ws-stack">
              <div className="rounded-card bg-surface px-4 py-2.5 shadow-card">
                <div className="flex items-center gap-3">
                  <Skel w={14} h={14} circle />
                  <Skel w="32%" h={12} />
                  <div className="flex-1" />
                  <Skel w={30} h={18} block />
                </div>
              </div>
              <div className="overflow-hidden rounded-card bg-surface shadow-card">
                <div className="flex items-start gap-2 px-4 py-3">
                  <Skel w={12} h={12} circle />
                  <div className="min-w-0 flex-1">
                    <Skel w={158} h={12} />
                    <div style={{ height: 7 }} />
                    <Skel w="64%" h={9} />
                  </div>
                </div>
                <div className="divide-y divide-line border-t border-line">
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="flex items-center gap-3 px-4 py-2.5">
                      <Skel w={16} h={16} block />
                      <div className="min-w-0 flex-1">
                        <Skel w={`${38 + ((row * 17) % 26)}%`} h={11} />
                      </div>
                      <Skel w={88} h={16} block />
                      <Skel w={52} h={20} block />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
