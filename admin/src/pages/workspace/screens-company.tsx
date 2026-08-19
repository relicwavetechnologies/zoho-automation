/**
 * "Company" scope — the admin surface.
 *
 * The list screens here (overview, AI Ops, activity) are the layer that decides
 * what an admin looks at. They used to be flat lists sitting above very
 * detailed drill-ins, which is backwards: you could study one run closely but
 * had no way to find the run worth studying. They now filter, summarise and
 * explain, and every row leads into the detail screens.
 *
 * Two screens have left. The company ceiling editor is gone — the ceiling is
 * still enforced and still explained wherever it locks something, but nothing
 * here edits it. The company connections page is gone too: its coverage panels
 * asked a question nobody was answering, and the three connections the company
 * actually holds moved to Connected apps, where the rest of what Divo can reach
 * is already read.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Building2, ChevronRight, Clock, Info, KeyRound, Lock,
  Search, ShieldCheck, TriangleAlert, Users,
} from 'lucide-react'
import {
  Bar, ClickRow, Empty, Fade, PageHeader, Panel, Prompt, Seg, Skel,
  SkelRows, Switch, compact, money, useStaged,
} from './ui'
import type { Toast } from './ui'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import {
  ROLE_LABEL, ago, displayName, durationLabel, initialsOf,
  useAuditLog, useCompanyDepartments, useDepartmentSpend, useOverview, useRuns,
  type Run,
} from './data/use-company'
import {
  useCompanyDaily, useCompanyScope, useDirectory, useSpendByModel, useSpendMembers,
} from '@/cursor/use-spend'
import { KEY_PROVIDERS, useProxyStatus, useSaveProxyKey, type KeyScope } from '@/cursor/use-proxy'
import { useCompanyForwards } from './data/use-mail-governance'
import { cleanRunSummary, runTitle } from './data/use-my-activity'
import { useProxyPolicies, useSaveProxyPolicy } from '@/cursor/use-proxy-policy'

/** The cursor hooks take a token and a company; every screen here needs both. */
function useAdminScope() {
  const { token } = useAdminAuth()
  return { token, companyId: useCompanyScope() }
}

type Props = { replay: number; toast: Toast; go: (screen: string) => void }

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)

/** "27 Jul" — the axis wants a day, not an ISO string. */
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/**
 * Audit actions are dotted machine names. This turns the common ones into a
 * sentence and leaves anything unrecognised legible rather than blank, so a new
 * backend action never renders as an empty row.
 */
const CHANNEL_LABEL: Record<string, string> = { lark: 'Lark', desktop: 'Desktop', web: 'Web', api: 'API' }
const STATUS_LABEL: Record<string, string> = { completed: 'Done', running: 'Running', failed: 'Failed' }

const statusColour = (status: string) =>
  status === 'failed' ? 'var(--cur-error)' : status === 'running' ? 'var(--cur-primary)' : 'var(--cur-success)'

const RunBadge = ({ status }: { status: string }) => (
  <span className={status === 'failed' ? 'badge b-err' : status === 'running' ? 'badge b-run' : 'badge b-ok'}>
    <span className="dot" />{STATUS_LABEL[status] ?? status}
  </span>
)

/** "Today", "Yesterday", else the date — the grouping header above a day's runs. */
const onDay = (iso: string): string => {
  const then = new Date(iso)
  const today = new Date()
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((midnight(today) - midnight(then)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}

/** Resolves an audit row's actor against the directory the caller already has. */
const auditActor = (actorId: string | null, directory: { userId: string; name: string | null; email: string }[]) => {
  if (!actorId) return 'System'
  const person = directory.find((p) => p.userId === actorId)
  return person ? displayName(person.name, person.email) : actorId
}

const auditPhrase = (action: string): string => {
  const known: Record<string, string> = {
    'permission.set_company_action': 'Changed a company permission',
    'permission.set_dept_action': 'Changed a role permission',
    'permission.set_dept_member_action': 'Added a personal exception',
    'permission.clear_dept_member_action': 'Removed a personal exception',
    'department_manager.membership.removed': 'Removed someone from a department',
    'department_manager.approval_policy.updated': 'Changed an approval policy',
  }
  return known[action] ?? action.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
const pctChange = (now: number, before: number) => (before === 0 ? 0 : Math.round(((now - before) / before) * 100))

const Delta = ({ pct, tone }: { pct: number; tone?: 'warn' | 'good' }) => (
  <span className="ws-delta" data-tone={tone}>{pct >= 0 ? '+' : '−'}{Math.abs(pct)}%</span>
)

function DayChart({ days, hotFrom }: { days: { label: string; v: number }[]; hotFrom: number }) {
  const max = Math.max(...days.map((d) => d.v), 1)
  return (
    <>
      <div className="ws-chart">
        {days.map((d, i) => (
          <div className="ws-chart-col" key={d.label} data-hot={i >= hotFrom} data-peak={d.v === max}>
            <span className="ws-chart-tip">{d.label} · {money(d.v)}</span>
            <i style={{ height: `${(d.v / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="ws-chart-x">
        <span>{days[0].label}</span>
        <span>{days[Math.floor(days.length / 2)].label}</span>
        <span>{days[days.length - 1].label}</span>
      </div>
    </>
  )
}

/* ══ Company overview ══════════════════════════════════
   Not a tile grid. Four numbers that carry their direction, a spend curve with
   the reason for its shape attached, and the short list of things that will go
   wrong if nobody touches them. */
export function CompanyHome({ replay, go }: Props) {
  const { session } = useAdminAuth()
  const [r1, r2, r3] = useStaged([240, 480, 700], replay)
  const { token, companyId } = useAdminScope()
  const { data: overview } = useOverview(30)
  const daily = useCompanyDaily(token, 14, companyId).data
  const spendQuery = useSpendMembers(token, 30, companyId)
  const memberSpend = spendQuery.data
  const directoryQuery = useDirectory(token, companyId)
  const directory = directoryQuery.data ?? []
  const departmentsQuery = useCompanyDepartments()
  const { data: departments } = departmentsQuery
  const { spend: deptSpend } = useDepartmentSpend(departments, 30)
  const { data: audit } = useAuditLog(6)

  /**
   * "Nothing needs you" is a claim about the whole company, and it is only
   * true if all three of these were actually read. Departments carry the
   * no-manager warning, member spend carries the over-budget one, and the
   * directory carries the unlinked-Lark one — so any of them failing turns an
   * unknown into a clean bill of health, which is the one answer an admin will
   * act on by doing nothing.
   */
  const attentionKnown =
    !departmentsQuery.loading && !departmentsQuery.error &&
    !spendQuery.isPending && !spendQuery.isError &&
    !directoryQuery.isPending && !directoryQuery.isError

  const days = (daily?.series ?? []).map((point) => ({ label: shortDate(point.date), v: point.spendUsd }))
  const last7 = sum(days.slice(-7).map((d) => d.v))
  const prev7 = sum(days.slice(0, Math.max(days.length - 7, 0)).map((d) => d.v))
  const active = departments.filter((d) => d.status === 'active')
  const unmanaged = active.filter((d) => d.managerCount === 0)
  const overBudget = (memberSpend?.members ?? []).filter((m) => m.usagePct >= 85)
  const unlinked = directory.filter((p) => !p.larkLinked)
  const totalDeptSpend = sum(Object.values(deptSpend).map((s) => s.spendUsd))
  const completed = Math.round(overview.executions.total * (overview.successRate / 100))
  const failed = Math.max(overview.executions.total - completed, 0)

  /**
   * Everything here is derived from something the backend actually reports.
   * A warning nobody can act on, or one that turns out to be invented, costs
   * more trust than an empty panel does.
   */
  const attention = [
    ...unmanaged.map((d) => ({
      tone: 'warn' as const,
      title: `${d.name} has no manager`,
      body: `Nobody can approve gated actions for these ${d.memberCount} people, so Divo fails closed and anything needing approval simply stops.`,
      meta: [`${d.memberCount} ${d.memberCount === 1 ? 'person' : 'people'} affected`],
      cta: 'Assign',
      onClick: () => go('co-departments'),
    })),
    ...overBudget.slice(0, 2).map((m) => ({
      tone: 'act' as const,
      title: `${displayName(m.name, m.email)} is at ${Math.round(m.usagePct)}% of their monthly tokens`,
      body: 'Past the limit the proxy refuses the call and the run stops mid-task, which the person sees as Divo breaking.',
      meta: [`${compact(m.tokens)} of ${compact(m.monthlyLimit)} tokens`, money(m.spend30d)],
      cta: 'Raise it',
      onClick: () => go('co-guardrails'),
    })),
    ...(unlinked.length
      ? [{
          tone: 'warn' as const,
          title: `${unlinked.length} ${unlinked.length === 1 ? 'person has' : 'people have'} no Lark identity`,
          body: 'Divo in Lark cannot recognise them, so it answers as if they were a stranger. Signing in once on the web links the two.',
          meta: unlinked.slice(0, 4).map((p) => displayName(p.name, p.email)),
          cta: 'See who',
          onClick: () => go('co-people'),
        }]
      : []),
  ]

  return (
    <>
      <PageHeader
        eyebrow={session?.companyName ?? 'Company'}
        title="Company"
        description={`${directory.length} ${directory.length === 1 ? 'person' : 'people'} across ${active.length} ${active.length === 1 ? 'department' : 'departments'}. You set the ceiling every team works within.`}
      />
      <div className="ws-stack">
        <Panel title="Needs you">
          {!r1 ? <SkelRows n={3} icon={false} /> : attention.length === 0 && !attentionKnown ? (
            <Empty
              icon={TriangleAlert}
              title="Could not check"
              body="Departments, spend or the directory did not load, so this cannot tell you whether anything needs you."
            />
          ) : attention.length === 0 ? (
            <Empty icon={ShieldCheck} title="Nothing needs you" body="Every department has a manager and nobody is near their limit." />
          ) : (
            <Fade>
              <div className="ws-attn">
                {attention.map((a, i) => (
                  <div className="ws-attn-item" data-tone={a.tone} key={i}>
                    <span className="ws-attn-bar" />
                    <div className="ws-attn-main">
                      <b>{a.title}</b>
                      <p>{a.body}</p>
                      <div className="ws-attn-meta">{a.meta.map((m) => <span key={m}>{m}</span>)}</div>
                    </div>
                    <button type="button" className="btn" onClick={a.onClick}>{a.cta}</button>
                  </div>
                ))}
              </div>
            </Fade>
          )}
        </Panel>

        <Panel title="Last 30 days">
          {!r2 ? (
            <div className="ws-panel-body"><Skel w="100%" h={72} /></div>
          ) : (
            <Fade>
              <div className="ws-metrics">
                <div className="ws-metric">
                  <div className="k">Spend</div>
                  <div className="v">{money(last7)}<Delta pct={pctChange(last7, prev7)} tone={last7 > prev7 ? 'warn' : 'good'} /></div>
                  <div className="s">Last 7 days, against the 7 before</div>
                </div>
                <div className="ws-metric">
                  <div className="k">Runs</div>
                  <div className="v">
                    {overview.executions.total.toLocaleString()}
                    {overview.executions.growthPct !== null ? <Delta pct={Math.round(overview.executions.growthPct)} /> : null}
                  </div>
                  <div className="s">{overview.channelBreakdown.map((c) => c.channel).join(' and ') || 'No runs yet'}</div>
                </div>
                <div className="ws-metric">
                  <div className="k">People active</div>
                  <div className="v">{overview.activeMembers}<span className="ws-sub">of {directory.length}</span></div>
                  <div className="s">
                    {directory.length - overview.activeMembers > 0
                      ? `${directory.length - overview.activeMembers} have run nothing`
                      : 'Everyone has used Divo'}
                  </div>
                </div>
                <div className="ws-metric">
                  <div className="k">Runs that failed</div>
                  <div className="v">{failed}</div>
                  <div className="s">{overview.successRate}% completed</div>
                </div>
              </div>
            </Fade>
          )}
          <div className="ws-panel-body" style={{ borderTop: '1px solid var(--cur-hairline)' }}>
            {!r2 ? <Skel w="100%" h={118} /> : days.length === 0 ? (
              <Empty title="No spend recorded yet" body="Nothing has run in this window." />
            ) : (
              <Fade>
                <div className="ws-lbl">Spend per day</div>
                <div style={{ marginTop: 14 }}><DayChart days={days} hotFrom={Math.max(days.length - 7, 0)} /></div>
                <div className="ws-why">
                  <Info size={14} />
                  <div>
                    Priced per model from the token counts each run reported, with cached input charged at its own
                    rate — {daily?.cacheSavingsPct ?? 0}% of input tokens were served from cache in this window.
                  </div>
                </div>
              </Fade>
            )}
          </div>
        </Panel>

        <div className="ws-cols">
          <Panel
            title="Where it went"
            description="Last 30 days by department"
            aside={<button type="button" className="btn" onClick={() => go('co-departments')}>Manage</button>}
          >
            {!r3 ? <SkelRows n={4} /> : active.length === 0 ? (
              <Empty icon={Building2} title="No departments yet" />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {active.map((d) => {
                    const spent = deptSpend[d.id]?.spendUsd ?? 0
                    const share = totalDeptSpend > 0 ? (spent / totalDeptSpend) * 100 : 0
                    return (
                      <ClickRow key={d.id} onOpen={() => go('co-departments')}>
                        <span className="ws-ic" data-tone={d.managerCount ? undefined : 'warn'}><Building2 size={14} /></span>
                        <div className="ws-row-main">
                          <b>{d.name}</b>
                          <p>{d.memberCount} people · {d.managerCount ? `${d.managerCount} manager${d.managerCount > 1 ? 's' : ''}` : 'no manager'}</p>
                          <div style={{ marginTop: 9, maxWidth: 300 }}>
                            <Bar pct={share} tone={share > 40 ? 'mark' : undefined} />
                          </div>
                        </div>
                        <span className="ws-sub">{money(spent)}</span>
                      </ClickRow>
                    )
                  })}
                </div>
              </Fade>
            )}
          </Panel>

          <Panel
            title="Latest changes"
            aside={<button type="button" className="btn" onClick={() => go('co-audit')}>All activity</button>}
          >
            {!r3 ? <SkelRows n={4} icon={false} /> : audit.length === 0 ? (
              <Empty title="Nothing changed yet" />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {audit.slice(0, 5).map((entry) => (
                    <div className="ws-row" key={entry.id}>
                      <div className="ws-row-main">
                        <b style={{ fontWeight: 400 }}>{auditPhrase(entry.action)}</b>
                        <p>{auditActor(entry.actorId, directory)} · {ago(entry.createdAt)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

/* ══ Directory ═════════════════════════════════════════ */
export function CompanyPeople({ replay, go }: Props) {
  const { session } = useAdminAuth()
  const [r1] = useStaged([300], replay)
  const [query, setQuery] = useState('')
  const { token, companyId } = useAdminScope()
  const { data: directoryData, isLoading: loading } = useDirectory(token, companyId)
  const memberSpend = useSpendMembers(token, 30, companyId).data
  const directory = directoryData ?? []

  const spendByUser = new Map((memberSpend?.members ?? []).map((m) => [m.userId, m]))
  const list = directory.filter((p) =>
    `${p.name ?? ''} ${p.email}`.toLowerCase().includes(query.toLowerCase()))

  return (
    <>
      <PageHeader
        eyebrow={session?.companyName ?? 'Company'}
        title="Everyone"
        description="The company directory. Open anyone to see their departments, spend and guardrails."
      />
      <div className="filters">
        <div className="search" style={{ maxWidth: 300 }}>
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find anyone"
          />
        </div>
      </div>
      <Panel source="teamPeople">
        {!r1 || loading ? <SkelRows n={6} /> : list.length === 0 ? (
          <Empty icon={Users} title="Nobody matches" />
        ) : (
          <Fade>
            <div className="ws-rows">
              {list.map((p) => {
                const spend = spendByUser.get(p.userId)
                return (
                  <ClickRow key={p.userId} onOpen={() => go(`co-person:${p.userId}`)}>
                    <span className="avatar">{initialsOf(p.name, p.email)}</span>
                    <div className="ws-row-main">
                      <b>
                        {displayName(p.name, p.email)}
                        {p.managerDepartmentCount > 0 ? <span className="ws-tag">Manager</span> : null}
                        {/* A person with no Lark identity is invisible to Divo in Lark,
                            which looks like a bug to them and to whoever they ask. */}
                        {!p.larkLinked ? <span className="ws-prov" data-src="department_user_override">No Lark identity</span> : null}
                      </b>
                      <p>
                        {p.email} · {ROLE_LABEL[p.companyRole] ?? p.companyRole}
                        {p.departmentNames.length ? ` · ${p.departmentNames.join(', ')}` : ' · no department'}
                      </p>
                    </div>
                    <div className="ws-row-act">
                      <span className="ws-sub">{money(spend?.spend30d ?? 0)}</span>
                      <span className="ws-sub">{spend?.runs ?? 0} tasks</span>
                    </div>
                  </ClickRow>
                )
              })}
            </div>
          </Fade>
        )}
      </Panel>
    </>
  )
}

/* ══ Departments ═══════════════════════════════════════ */
export function CompanyDepartments({ replay, toast, go }: Props) {
  const { session } = useAdminAuth()
  const [r1] = useStaged([280], replay)
  const { data: departments, loading, createDepartment } = useCompanyDepartments()
  const [creating, setCreating] = useState(false)
  const active = departments.filter((d) => d.status === 'active')
  const { spend } = useDepartmentSpend(active, 30)

  return (
    <>
      <PageHeader
        eyebrow={session?.companyName ?? 'Company'}
        title="Departments"
        description="A department is the only unit below the company. Its manager is whoever holds the Manager role in it."
        actions={<button type="button" className="btn primary" onClick={() => setCreating(true)}>New department</button>}
      />
      <Panel source="teamPeople">
        {!r1 || loading ? <SkelRows n={4} /> : active.length === 0 ? (
          <Empty icon={Building2} title="No departments yet" body="Every person needs a department before Divo can grant them anything." />
        ) : (
          <Fade>
            <div className="ws-rows">
              {active.map((d) => (
                <ClickRow key={d.id} onOpen={() => go(`co-department:${d.id}`)}>
                  <span className="ws-ic" data-tone={d.managerCount ? undefined : 'warn'}><Building2 size={14} /></span>
                  <div className="ws-row-main">
                    <b>
                      {d.name}
                      {!d.managerCount ? <span className="ws-prov" data-src="department_user_override">No manager</span> : null}
                    </b>
                    <p>
                      {d.memberCount} {d.memberCount === 1 ? 'person' : 'people'} · {d.roleCount} {d.roleCount === 1 ? 'role' : 'roles'} ·{' '}
                      {d.managerCount
                        ? `${d.managerCount} manager${d.managerCount > 1 ? 's' : ''}`
                        : 'nobody can approve for this team'}
                    </p>
                  </div>
                  <span className="ws-sub">{money(spend[d.id]?.spendUsd ?? 0)}</span>
                </ClickRow>
              ))}
            </div>
          </Fade>
        )}
        <div className="ws-panel-foot">
          There are no reporting lines in Divo — "manager" means holding the Manager role in a department, nothing more.
        </div>
      </Panel>

      {creating ? (
        <Prompt
          title="New department"
          description="A department is where access is decided. Give it a name and add people once it exists."
          label="Name"
          placeholder="Finance"
          confirm="Create"
          onClose={() => setCreating(false)}
          onConfirm={async (name) => {
            try { await createDepartment(name); toast(`${name} created`) }
            catch { toast('Could not create that department', 'error') }
          }}
        />
      ) : null}
    </>
  )
}

/* ══ Activity / audit ══════════════════════════════════
   An audit line that says "changed permissions" is not an audit line. Every
   entry expands into what the value was and what it became — as far as the
   recorded metadata allows, which is honestly less than the design assumed. */

/**
 * Which family a recorded action belongs to.
 *
 * Derived from the action string rather than stored, because the backend writes
 * a dotted name and nothing else. Grouping by prefix keeps a new action legible
 * — it lands in `other` instead of vanishing from every filter.
 */
/*
 * `run` is not a governance change, and that is exactly why it needs its own
 * name. The log is dominated by `gateway.tool.*` — 174 of the last 200 here —
 * and with nothing to call them they all fell into "Other", which left five
 * filters where four read zero and the fifth held everything. A filter that
 * cannot divide anything is not a filter.
 */
type AuditKind = 'permission' | 'member' | 'connection' | 'approval' | 'run' | 'other'

const KIND_LABEL: Record<AuditKind, string> = {
  permission: 'Permissions',
  member: 'People',
  connection: 'Connections',
  approval: 'Approvals',
  run: 'Tool runs',
  other: 'Other',
}

const kindOf = (action: string): AuditKind => {
  if (action.startsWith('permission.')) return 'permission'
  if (action.includes('membership') || action.includes('member') || action.includes('invite')) return 'member'
  if (action.includes('connection')) return 'connection'
  if (action.includes('approval')) return 'approval'
  // Checked last, so a gateway action that is *about* a grant or an approval
  // still files under what it changed rather than under where it came from.
  if (action.startsWith('gateway.') || action.includes('invocation') || action.includes('skill.')) return 'run'
  return 'other'
}

/** Metadata is free-form; this renders it as before/after rows where it can. */
const metadataRows = (metadata: Record<string, unknown> | null): { k: string; v: string }[] => {
  if (!metadata) return []
  return Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => ({ k: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), v: String(v) }))
}

export function CompanyAudit({ replay }: Props) {
  const { session } = useAdminAuth()
  const [r1] = useStaged([300], replay)
  const [kinds, setKinds] = useState<AuditKind[]>([])
  const [actor, setActor] = useState('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const { token, companyId } = useAdminScope()
  const { data: entries, loading } = useAuditLog(200)
  /*
   * One gate for the whole panel, so its three parts cannot disagree.
   *
   * The counts, the chips and the rows each decided for themselves whether the
   * log had arrived: the rows waited, and the other two did not — which is how
   * "0 of 0 changes" came to sit directly above six loading rows.
   */
  const loadingLog = !r1 || loading
  const directory = useDirectory(token, companyId).data ?? []

  const nameById = useMemo(
    () => new Map(directory.map((p) => [p.userId, displayName(p.name, p.email)])),
    [directory],
  )
  // An actor who has since left the company still has rows here, so an unknown
  // id falls back to the id rather than to a blank.
  const actorName = (id: string | null) => (id ? nameById.get(id) ?? id : 'System')

  const actors = useMemo(
    () => Array.from(new Set(entries.map((e) => e.actorId).filter((id): id is string => Boolean(id)))),
    [entries],
  )
  const counts = useMemo(() => {
    const out = {} as Record<AuditKind, number>
    for (const e of entries) { const k = kindOf(e.action); out[k] = (out[k] ?? 0) + 1 }
    return out
  }, [entries])

  const list = entries.filter((e) => {
    if (kinds.length && !kinds.includes(kindOf(e.action))) return false
    if (actor !== 'all' && e.actorId !== actor) return false
    if (query && !`${auditPhrase(e.action)} ${actorName(e.actorId)}`.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const days = Array.from(new Set(list.map((e) => onDay(e.createdAt))))
  const filtered = kinds.length > 0 || actor !== 'all' || query.length > 0
  const toggleKind = (k: AuditKind) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))

  return (
    <>
      <PageHeader
        eyebrow={session?.companyName ?? 'Company'}
        title="Activity"
        /* It said "every permission grant, connection and approval decision",
           which is true and describes about one row in eight. The rest is Divo
           acting — tool runs, skill lookups — and a reader who trusted the
           sentence would have read 174 tool invocations as governance changes
           nobody could account for. */
        description="What Divo did, and who changed what it may do. Permission grants, connections and approval decisions are recorded alongside the runs themselves — including the changes that quietly overrode somebody else."
      />

      <div className="filters">
        <div className="search" style={{ maxWidth: 260 }}>
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search changes"
          />
        </div>
        <select className="select" value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="all">Anyone</option>
          {actors.map((a) => <option key={a} value={a}>{actorName(a)}</option>)}
        </select>
        {(Object.keys(KIND_LABEL) as AuditKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className="ws-chip"
            data-on={kinds.includes(k)}
            data-empty={!loadingLog && !counts[k]}
            onClick={() => toggleKind(k)}
          >
            {/* No number until there is one. A chip reading "Permissions 0"
                during the read is a claim that nothing was ever changed, and it
                is the answer an auditor is least able to check. */}
            {KIND_LABEL[k]}{loadingLog ? null : <span className="n">{counts[k] ?? 0}</span>}
          </button>
        ))}
        {filtered ? (
          <button type="button" className="btn ws-filter-x" onClick={() => { setKinds([]); setActor('all'); setQuery('') }}>
            Clear
          </button>
        ) : null}
      </div>

      <Panel>
        {/* The tally waits for the rows it is tallying. It sat above the
            skeletons reading "0 of 0 changes | 0 people" — a page stating the
            audit log is empty while still fetching it. */}
        {loadingLog ? (
          <div className="ws-sum"><Skel w={150} h={11} /></div>
        ) : (
          <div className="ws-sum">
            <span><b>{list.length}</b> of {entries.length} {entries.length === 1 ? 'change' : 'changes'}</span>
            <span className="sep" />
            {(() => {
              // "1 people" — the count is usually plural, so the singular was
              // never seen until a company had one active person in the window.
              const actors = new Set(list.map((e) => e.actorId)).size
              return <span><b>{actors}</b> {actors === 1 ? 'person' : 'people'}</span>
            })()}
          </div>
        )}
        {loadingLog ? <SkelRows n={6} icon={false} /> : list.length === 0 ? (
          <Empty
            title="Nothing matches"
            body={filtered
              ? 'Try a wider filter — activity is only recorded for changes, not for reads.'
              : 'Nothing has been changed yet.'}
          />
        ) : (
          <Fade>
            <div className="ws-rows">
              {days.map((day) => (
                <Fragment key={day}>
                  <div className="ws-day">{day}</div>
                  {list.filter((e) => onDay(e.createdAt) === day).map((e) => {
                    const isOpen = open === e.id
                    const rows = metadataRows(e.metadata)
                    const who = actorName(e.actorId)
                    return (
                      <div className="ws-row" key={e.id} style={{ alignItems: 'flex-start' }}>
                        <span className="avatar">{initialsOf(who, who)}</span>
                        <div className="ws-row-main">
                          <b style={{ fontWeight: 400 }}>
                            {auditPhrase(e.action)}
                            {e.outcome !== 'success' ? <span className="ws-tag">{e.outcome}</span> : null}
                          </b>
                          <p>{who} · {ago(e.createdAt)}</p>
                          {isOpen ? (
                            rows.length ? (
                              <div className="ws-ba">
                                {rows.map((r) => (
                                  <div className="ws-ba-r" key={r.k}>
                                    <span className="k">{r.k}</span>
                                    <span className="to">{r.v}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="ws-why" style={{ marginTop: 10 }}>
                                <Info size={14} />
                                <div>Nothing beyond the action itself was recorded for this change.</div>
                              </div>
                            )
                          ) : null}
                          {rows.length || isOpen ? (
                            <div style={{ marginTop: 9 }}>
                              <button type="button" className="ws-more" data-open={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>
                                <ChevronRight size={13} />{isOpen ? 'Hide' : 'What changed'}
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <span className="ws-tag">{KIND_LABEL[kindOf(e.action)]}</span>
                      </div>
                    )
                  })}
                </Fragment>
              ))}
            </div>
          </Fade>
        )}
        <div className="ws-panel-foot">
          Written on every permission change and every governed tool run. A read Divo was never asked to make is not recorded.
        </div>
      </Panel>
    </>
  )
}

/* ══════════════════════════════════════════════════════
   Surfaces absorbed from the existing admin app.

   These exist today as standalone admin pages wired to live endpoints. They
   are re-specified here inside the Company scope so the whole product lives in
   one shell. Data mapping comes later — the hooks in `admin/src/cursor/` are
   kept and will be plugged straight in.
   ══════════════════════════════════════════════════════ */

/* ══ AI Ops ════════════════════════════════════════════ */
export function CompanyAiOps({ replay, go }: Props) {
  const { session } = useAdminAuth()
  const [r1, r2] = useStaged([280, 560], replay)
  const [tab, setTab] = useState<'runs' | 'failures' | 'cost'>('runs')
  const [channels, setChannels] = useState<string[]>([])
  const [statuses, setStatuses] = useState<string[]>([])
  const [query, setQuery] = useState('')

  const { data: runs, loading } = useRuns({ limit: 200 })
  const { token, companyId } = useAdminScope()
  const byModel = useSpendByModel(token, 30, companyId).data ?? []
  const { data: departments } = useCompanyDepartments()
  const activeDepts = departments.filter((d) => d.status === 'active')
  const { spend: deptSpend } = useDepartmentSpend(activeDepts, 30)
  const desktopSpend = useCompanyDaily(token, 30, companyId, 'desktop').data
  const larkSpend = useCompanyDaily(token, 30, companyId, 'lark').data
  const runsReady = r1 && !loading

  const list = runs.filter((r) => {
    if (channels.length && !channels.includes(r.channel)) return false
    if (statuses.length && !statuses.includes(r.status)) return false
    if (query && !`${runTitle({ summary: r.latestSummary, channel: r.channel })} ${r.userName ?? ''}`.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  /** The same cause keeps hitting different people, so group by cause. */
  const failures = useMemo(() => {
    const out = new Map<string, Run[]>()
    for (const r of runs) {
      if (r.status !== 'failed') continue
      const reason = r.errorCode ?? r.errorMessage ?? 'No reason recorded'
      out.set(reason, [...(out.get(reason) ?? []), r])
    }
    return Array.from(out.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [runs])

  const channelsPresent = Array.from(new Set(runs.map((r) => r.channel)))
  const statusesPresent = Array.from(new Set(runs.map((r) => r.status)))
  const totalModel = sum(byModel.map((m) => m.costUsd))
  const totalDept = sum(Object.values(deptSpend).map((s) => s.spendUsd))
  const filtered = channels.length > 0 || statuses.length > 0 || query.length > 0
  const runCost = (r: Run) => r.costUsd ?? 0

  useEffect(() => {
    document.title = 'AI Ops - Divo'
  }, [])

  return (
    <>
      <PageHeader
        eyebrow={session?.companyName ?? 'Company'}
        title="AI Ops"
        description="Every task Divo has run for anyone, and what each one cost. Cost is priced from real token counts, not estimated."
      />
      <div className="filters">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'runs', label: 'Runs' },
            { value: 'failures', label: `Failures · ${runs.filter((r) => r.status === 'failed').length}` },
            { value: 'cost', label: 'Cost' },
          ]}
        />
      </div>

      {tab === 'runs' ? (
        <>
          <div className="filters">
            <div className="search" style={{ maxWidth: 240 }}>
              <Search size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search runs"
              />
            </div>
            {channelsPresent.map((c) => (
              <button
                key={c}
                type="button"
                className="ws-chip"
                data-on={channels.includes(c)}
                onClick={() => setChannels((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))}
              >
                {CHANNEL_LABEL[c] ?? c}<span className="n">{runs.filter((r) => r.channel === c).length}</span>
              </button>
            ))}
            {statusesPresent.map((s) => (
              <button
                key={s}
                type="button"
                className="ws-chip"
                data-on={statuses.includes(s)}
                onClick={() => setStatuses((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}
              >
                <span className="ws-chip-dot" style={{ background: statusColour(s) }} />
                {STATUS_LABEL[s] ?? s}<span className="n">{runs.filter((r) => r.status === s).length}</span>
              </button>
            ))}
            {filtered ? (
              <button type="button" className="btn ws-filter-x" onClick={() => { setChannels([]); setStatuses([]); setQuery('') }}>
                Clear
              </button>
            ) : null}
          </div>

          <Panel>
            {runsReady ? (
              <div className="ws-sum">
                <span><b>{list.length}</b> runs</span>
                <span className="sep" />
                <span><b>{money(sum(list.map(runCost)))}</b> spent</span>
                <span className="sep" />
                <span><b>{list.filter((r) => r.status === 'failed').length}</b> failed</span>
                <span className="sep" />
                <span><b>{list.filter((r) => r.status === 'running').length}</b> still open</span>
              </div>
            ) : (
              <div className="ws-sum" aria-hidden="true">
                <Skel w={64} h={16} />
                <span className="sep" />
                <Skel w={78} h={16} />
                <span className="sep" />
                <Skel w={58} h={16} />
                <span className="sep" />
                <Skel w={84} h={16} />
              </div>
            )}
            {!runsReady ? <SkelRows n={6} /> : list.length === 0 ? (
              <Empty title="No runs match" body={filtered ? 'Widen the filter.' : 'Nothing has run yet.'} />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {Array.from(new Set(list.map((r) => onDay(r.startedAt)))).map((day) => (
                    <Fragment key={day}>
                      <div className="ws-day">{day}</div>
                      {list.filter((r) => onDay(r.startedAt) === day).map((r) => {
                        const summary = cleanRunSummary(r.latestSummary)
                        return (
                        <ClickRow key={r.id} onOpen={() => go(`co-run:${r.id}`)}>
                          <span className="avatar">{initialsOf(r.userName, r.userName ?? '?')}</span>
                          <div className="ws-row-main">
                            <b>
                              {runTitle({ summary: r.latestSummary, channel: r.channel })}
                              {r.status === 'running' && r.channel === 'lark' ? (
                                <span className="ws-note" title="The LLM proxy creates Lark runs and never closes them, so status and duration are unreliable for this channel.">
                                  status unknown
                                </span>
                              ) : null}
                            </b>
                            <p>
                              {r.userName ?? 'Unattributed'} · {ago(r.startedAt)}
                              {summary ? ` · ${CHANNEL_LABEL[r.channel] ?? r.channel}` : ''}
                              {durationLabel(r.durationMs) ? ` · ${durationLabel(r.durationMs)}` : ''}
                              {r.errorCode ? ` · ${r.errorCode}` : ''}
                            </p>
                          </div>
                          <div className="ws-row-act">
                            <span className="ws-sub">{r.costUsd === null ? 'unattributed' : money(r.costUsd)}</span>
                            <RunBadge status={r.status} />
                          </div>
                        </ClickRow>
                        )
                      })}
                    </Fragment>
                  ))}
                </div>
              </Fade>
            )}
            <div className="ws-panel-foot">
              <TriangleAlert size={13} />
              Lark runs are never terminated by the backend — do not build a completed-vs-failed chart that includes them
            </div>
          </Panel>
        </>
      ) : tab === 'failures' ? (
        <Panel title="Why runs failed" description="Grouped by cause, because the same cause keeps hitting different people">
          {!r1 || loading ? <SkelRows n={4} icon={false} /> : failures.length === 0 ? (
            <Empty icon={ShieldCheck} title="Nothing has failed" body="Every run in this window finished or is still going." />
          ) : (
            <Fade>
              <div className="ws-rows">
                {failures.map(([reason, group]) => (
                  <div className="ws-row" key={reason} style={{ alignItems: 'flex-start' }}>
                    <span className="ws-ic" data-tone="err"><TriangleAlert size={14} /></span>
                    <div className="ws-row-main">
                      <b>{reason}<span className="ws-tag">{group.length} {group.length === 1 ? 'run' : 'runs'}</span></b>
                      <p>{group[0]!.errorMessage ?? 'No further detail was recorded.'}</p>
                      <div className="ws-attn-meta">
                        <span>{Array.from(new Set(group.map((r) => r.userName ?? 'Unattributed'))).join(', ')}</span>
                        <span>Most recent {ago(group[0]!.startedAt)}</span>
                      </div>
                      <div style={{ marginTop: 11, display: 'flex', gap: 8 }}>
                        <button type="button" className="btn" onClick={() => go(`co-run:${group[0]!.id}`)}>Open a run</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            <Clock size={13} />
            Expired-token failures are invisible to the person — the run stops and Divo says nothing useful
          </div>
        </Panel>
      ) : (
        <div className="ws-stack">
          <Panel title="Cost by model" description={`${money(totalModel)} across the last 30 days`}>
            <div className="ws-panel-body">
              {!r2 ? <SkelRows n={3} icon={false} /> : byModel.length === 0 ? (
                <Empty title="No model calls recorded" />
              ) : (
                <Fade>
                  {byModel.map((m) => (
                    <div key={m.modelId} style={{ marginBottom: 18 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{m.modelId} <span className="ws-sub">{m.provider}</span></span>
                        <span className="ws-sub">{m.calls} calls · {money(m.costUsd)}</span>
                      </div>
                      <Bar
                        pct={totalModel > 0 ? (m.costUsd / totalModel) * 100 : 0}
                        tone={totalModel > 0 && m.costUsd / totalModel > 0.4 ? 'mark' : undefined}
                      />
                    </div>
                  ))}
                </Fade>
              )}
            </div>
            <div className="ws-panel-foot">
              Priced from real cache-split token counts — not the blended estimate the old analytics KPIs used
            </div>
          </Panel>

          <div className="ws-cols-even">
            <Panel title="By department">
              <div className="ws-panel-body">
                {!r2 ? <SkelRows n={4} icon={false} /> : (
                  <Fade>
                    {activeDepts.map((d) => (
                      <div key={d.id} style={{ marginBottom: 16 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 12 }}>
                          <span>{d.name} <span className="ws-sub">{d.memberCount} people</span></span>
                          <span className="ws-sub">{money(deptSpend[d.id]?.spendUsd ?? 0)}</span>
                        </div>
                        <Bar pct={totalDept > 0 ? ((deptSpend[d.id]?.spendUsd ?? 0) / totalDept) * 100 : 0} />
                      </div>
                    ))}
                  </Fade>
                )}
              </div>
              <div className="ws-panel-foot">
                A person in no department is counted by the company total and by none of these rows
              </div>
            </Panel>

            <Panel title="By channel">
              {!r2 ? <div className="ws-panel-body"><Skel w="100%" h={72} /></div> : (
                <Fade>
                  {/* `data-n` exists in the stylesheet for exactly this; an
                      inline override was a second way to say the same thing. */}
                  <div className="ws-metrics" data-n="2">
                    <div className="ws-metric">
                      <div className="k">Desktop</div>
                      <div className="v">{money(sum((desktopSpend?.series ?? []).map((p) => p.spendUsd)))}</div>
                      <div className="s">Longer tasks, higher cost each</div>
                    </div>
                    <div className="ws-metric">
                      <div className="k">Lark</div>
                      <div className="v">{money(sum((larkSpend?.series ?? []).map((p) => p.spendUsd)))}</div>
                      <div className="s">Short questions, most of the volume</div>
                    </div>
                  </div>
                </Fade>
              )}
              <div className="ws-panel-foot">
                Lark spend is understated — the proxy never closes those runs, so late turns are billed to nothing
              </div>
            </Panel>
          </div>
        </div>
      )}
    </>
  )
}

/* ══ Guardrails ════════════════════════════════════════ */
export function CompanyGuardrails({ replay, toast }: Props) {
  const { session } = useAdminAuth()
  const [r1] = useStaged([300], replay)
  const { token, companyId } = useAdminScope()
  const deepseek = useProxyStatus(token, 'deepseek', companyId).data
  const openai = useProxyStatus(token, 'openai', companyId).data
  const memberSpend = useSpendMembers(token, 30, companyId).data
  const policyQuery = useProxyPolicies(token, companyId)
  const policies = policyQuery.data ?? []
  const savePolicy = useSaveProxyPolicy(token, companyId)

  /**
   * Every switch below is held until this is true.
   *
   * Blocking somebody sends the complete next policy, because the route
   * replaces rather than patches. Composed from a list that failed to load,
   * that write carries `monthlyBudgetUsd: null`, `rateLimitRpm: null` and no
   * model grant — so one click on a row that merely *looks* unrestricted wipes
   * a real budget and drops them back to Flash-only. Nothing here is safe to
   * toggle until the policies are actually known.
   */
  const policiesKnown = policyQuery.isSuccess

  const policyFor = (userId: string) => policies.find((p) => p.userId === userId)
  const [keyFor, setKeyFor] = useState<'deepseek' | 'openai' | null>(null)
  const isSuperAdmin = session?.role === 'SUPER_ADMIN'
  const [keyScope, setKeyScope] = useState<KeyScope>('company')
  const saveDeepseek = useSaveProxyKey(token, 'deepseek', companyId)
  const saveOpenai = useSaveProxyKey(token, 'openai', companyId)
  // The catalogue owns the provider list and its one-line hints; this screen
  // had grown its own copy with the labels and none of the hints, which is two
  // places to add the next provider and one place to forget.
  const statusOf = { deepseek, openai }
  const keys = KEY_PROVIDERS.map((p) => ({ ...p, status: statusOf[p.id] }))

  const toggleBlocked = async (userId: string, name: string, nowBlocked: boolean) => {
    if (!policiesKnown) return
    const existing = policyFor(userId)
    try {
      // The route replaces the whole policy, so a partial write would silently
      // clear the budget and model list alongside the block.
      await savePolicy.mutateAsync({
        userId,
        input: {
          blocked: !nowBlocked,
          monthlyBudgetUsd: existing?.monthlyBudgetUsd ?? null,
          rateLimitRpm: existing?.rateLimitRpm ?? null,
          // Omitted when they have no stored policy: an empty list is a
          // validation failure, not "leave it alone".
          ...(existing?.allowedModels?.length ? { allowedModels: existing.allowedModels } : {}),
        },
      })
      toast(nowBlocked ? `${name} unblocked` : `${name} blocked`)
    } catch {
      toast('Could not change that limit', 'error')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={session?.companyName ?? 'Company'}
        title="Guardrails"
        description="Provider keys, and what each person is allowed to spend. This is the only limit that actually stops work."
      />
      <div className="ws-stack">
        {/* The other export nobody was watching. Spend is capped and a key can
            be pulled; a mail forward is a standing copy of whatever matches it,
            leaving the company every hour of every day, set up in one sentence
            to Divo. It belongs on the page about limits. */}
        <ExternalForwards token={token ?? undefined} />

        <Panel title="Provider keys" description="Held encrypted by the backend, never returned to any client">
          {!r1 ? <SkelRows n={2} /> : (
            <Fade>
              <div className="ws-rows">
                {keys.map(({ id, label, hint, status }) => (
                  <div className="ws-row" key={id}>
                    <span className="ws-ic" data-tone={status?.keyError ? 'err' : status?.configured ? 'ok' : undefined}>
                      <KeyRound size={14} />
                    </span>
                    <div className="ws-row-main">
                      <b>
                        {label}
                        {status?.scope === 'platform' ? <span className="ws-tag">Platform</span> : null}
                      </b>
                      <p>
                        {/* A key that exists but will not decrypt is the failure worth naming:
                            everything looks configured and every call 401s. */}
                        {status?.keyError === 'unreadable'
                          ? 'Stored but unreadable — the encryption secret has changed, so every call will fail'
                          : status?.configured
                            ? `${status.scope === 'platform' ? 'Platform' : 'Company'} key · ${status.keyMasked ?? status.keyLast4 ?? '····'} · ${status.upstream}`
                            : `Not configured — ${hint}`}
                      </p>
                    </div>
                    <button type="button" className="btn" onClick={() => setKeyFor(id)}>
                      {status?.configured ? 'Replace' : 'Add key'}
                    </button>
                  </div>
                ))}
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            <Lock size={13} />
            Platform-scoped keys are super-admin only
          </div>
        </Panel>

        <Panel
          title="Per-person limits"
          description="A monthly budget in dollars, enforced — the proxy refuses the call when it is reached"
        >
          {!r1 || policyQuery.isPending ? <SkelRows n={4} /> : !policiesKnown ? (
            <Empty
              icon={TriangleAlert}
              title="Could not read the limits"
              body="Every row here would otherwise read as allowed and unbudgeted, and blocking somebody from that state would erase their real budget. Nothing is shown until this loads."
              action={<button type="button" className="btn" onClick={() => void policyQuery.refetch()}>Try again</button>}
            />
          ) : (memberSpend?.members ?? []).length === 0 ? (
            <Empty title="Nobody has spent anything yet" body="Limits appear here once someone starts using Divo." />
          ) : (
            <Fade>
              <div className="ws-rows">
                {(memberSpend?.members ?? []).slice(0, 12).map((m) => {
                  const policy = policyFor(m.userId)
                  const isBlocked = policy?.blocked ?? false
                  const budget = policy?.monthlyBudgetUsd ?? null
                  const name = displayName(m.name, m.email)
                  return (
                    <div className="ws-row" key={m.userId}>
                      <span className="avatar">{initialsOf(m.name, m.email ?? '')}</span>
                      <div className="ws-row-main">
                        <b>{name}{policy?.isDefault !== false ? null : <span className="ws-prov" data-src="department_user_override">Custom limit</span>}</b>
                        <p>
                          {budget === null
                            ? `${money(m.spend30d)} in 30 days · no dollar budget set`
                            : `${money(m.spend30d)} of ${money(budget)} this month`}
                        </p>
                        {budget !== null ? (
                          <div style={{ marginTop: 8, maxWidth: 260 }}>
                            <Bar pct={(m.spend30d / budget) * 100} tone={m.spend30d / budget > 0.8 ? 'mark' : undefined} />
                          </div>
                        ) : null}
                      </div>
                      <div className="ws-row-act">
                        <span className="ws-sub">{isBlocked ? 'Blocked' : 'Allowed'}</span>
                        <Switch
                          on={!isBlocked}
                          label={`Allow ${name}`}
                          onToggle={() => void toggleBlocked(m.userId, name.split(' ')[0] ?? name, isBlocked)}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            <TriangleAlert size={13} />
            The separate monthly token limit is reported but not enforced — the dollar budget is the one that stops a run
          </div>
        </Panel>
      </div>

      {keyFor ? (
        <Prompt
          title={`${keyFor === 'deepseek' ? 'DeepSeek' : 'OpenAI'} key`}
          description="Stored encrypted by the backend and never returned to any client — this screen can only tell you that one exists."
          label="API key"
          placeholder="sk-…"
          confirm="Save key"
          secret
          /*
           * The scope choice appears only for a super-admin, because only a
           * super-admin may take it — the route rejects `platform` from anyone
           * else. It was previously hardcoded to `company`, so the one person
           * who can set a platform key had no way to do it from here, while the
           * panel above happily displayed platform keys with a tag. Showing the
           * state and withholding the control is the worse half of both.
           */
          extra={isSuperAdmin ? (
            <>
              <div className="ws-lbl">Applies to</div>
              <div style={{ marginTop: 8 }}>
                <Seg
                  value={keyScope}
                  onChange={(v) => setKeyScope(v as KeyScope)}
                  options={[
                    { value: 'company', label: session?.companyName ?? 'This company' },
                    { value: 'platform', label: 'Every company' },
                  ]}
                />
              </div>
              <p className="ws-sentence-note">
                {keyScope === 'platform'
                  ? 'Every company without its own key will bill to this one.'
                  : 'Used by this company only, and it overrides any platform key.'}
              </p>
            </>
          ) : undefined}
          onClose={() => { setKeyFor(null); setKeyScope('company') }}
          onConfirm={async (key) => {
            try {
              const save = keyFor === 'deepseek' ? saveDeepseek : saveOpenai
              // Never send `platform` from a non-super-admin: the control is
              // hidden for them, and the route would refuse it anyway.
              await save.mutateAsync({ key, keyScope: isSuperAdmin ? keyScope : 'company' })
              toast(keyScope === 'platform' && isSuperAdmin ? 'Platform key saved' : 'Key saved')
            } catch {
              toast('Could not save that key', 'error')
            }
          }}
        />
      ) : null}
    </>
  )
}

/**
 * Whose mail leaves the company, and where it goes.
 *
 * Every other limit on this page is something Divo enforces — a budget, a rate,
 * a blocked member. This one is a standing export that nobody is enforcing
 * anything about: a mail rule forwards the whole message, unchanged, every hour
 * of every day, and it is set up by asking Divo in one sentence. Each member can
 * see their own; until this, nobody could see all of them.
 *
 * Read-only, deliberately. Turning one off is the owner's action or an
 * administrator's, taken with the rule and its history in front of them — a
 * bulk switch on an audit page is how the rule carrying the invoices gets
 * turned off by somebody tidying up.
 */
function ExternalForwards({ token }: { token?: string }) {
  const [scope, setScope] = useState<'external' | 'all'>('external')
  const { forwards, totalForwards, externalCount, loading, error } =
    useCompanyForwards(token, { scope, includeInactive: true })

  return (
    <Panel
      title="Mail leaving the company"
      description="Rules that forward whole messages — headers, body and attachments — to an address."
      aside={
        <Seg
          value={scope}
          onChange={setScope}
          options={[
            { value: 'external', label: `Outside · ${externalCount}` },
            { value: 'all', label: `All forwards · ${totalForwards}` },
          ]}
        />
      }
    >
      {error ? (
        <div className="ws-ceiling">
          <TriangleAlert size={14} />
          <div><b>{error}</b> Treat this as unknown rather than as nothing.</div>
        </div>
      ) : null}

      {loading ? <SkelRows n={2} /> : forwards.length === 0 ? (
        <Empty
          icon={ShieldCheck}
          title={scope === 'external' ? 'No mail leaves the company' : 'No forwarding rules'}
          /* The two zeroes mean different things, and an auditor needs to know
             which one they are looking at. */
          body={scope === 'external' && totalForwards > 0
            ? `${totalForwards} forwarding rule${totalForwards === 1 ? '' : 's'} exist, and every one of them stays inside its own domain.`
            : 'Nobody has a rule that forwards mail to an address.'}
        />
      ) : (
        <Fade>
          <div className="ws-rows">
            {forwards.map((f) => (
              <div className="ws-row" key={f.ruleId}>
                <span className="ws-ic" data-tone={f.external ? 'err' : undefined}>
                  <ShieldCheck size={14} />
                </span>
                <div className="ws-row-main">
                  <b>
                    {f.mailboxEmail} → {f.destinationEmail}
                    {f.external ? <span className="ws-tag" data-tone="warn">Outside</span> : null}
                    {f.status !== 'active'
                      ? <span className="ws-tag">{f.status === 'paused' ? 'Paused' : 'Archived'}</span>
                      : null}
                  </b>
                  <p>
                    {f.ownerName ?? f.ownerEmail ?? 'Unknown owner'} · “{f.name}” · set up {ago(f.createdAt)}
                  </p>
                </div>
                <div className="ws-row-act">
                  <span className="ws-sub">
                    {/* Whole life, not a window — an export that ran for a year
                        and stopped is still an export that ran for a year. */}
                    {f.deliveredCount} sent
                    {f.lastDeliveredAt ? ` · last ${ago(f.lastDeliveredAt)}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Fade>
      )}

      <div className="ws-panel-foot">
        A forward outside the company needs a manager's approval before it starts. This is the
        standing list of the ones that were approved, and the ones that predate that rule.
      </div>
    </Panel>
  )
}
