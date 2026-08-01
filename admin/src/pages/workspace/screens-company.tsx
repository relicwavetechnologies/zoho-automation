/**
 * "Company" scope — the admin surface.
 *
 * The four list screens here (overview, AI Ops, activity, connections) are the
 * layer that decides what an admin looks at. They used to be flat lists sitting
 * above very detailed drill-ins, which is backwards: you could study one run
 * closely but had no way to find the run worth studying. They now filter,
 * summarise and explain, and every row leads into the detail screens.
 *
 * The company ceiling also finally sits visibly above the team grants that it
 * silently clamps, in the same shell as the member and manager views.
 */
import { Fragment, useMemo, useState } from 'react'
import {
  ArrowRight, Brain, Building2, Check, ChevronRight, Clock, Info, KeyRound, Lock, Plus,
  Search, ShieldCheck, Sparkles, Trash2, TriangleAlert, Users,
} from 'lucide-react'
import {
  ACTION_GROUPS, COMPANY_CEILING, CONNECTORS, MEMORIES, PEOPLE, SKILLS, TOOLS, toolById,
  type ActionGroup,
} from './fixtures'
import {
  Bar, Empty, Fade, PageHeader, Panel, ProviderMark, Seg, Skel, SkelRows,
  Switch, compact, money, useStaged,
} from './ui'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import {
  ROLE_LABEL, ago, displayName, durationLabel, initialsOf,
  useAuditLog, useCompanyDepartments, useDepartmentSpend, useDirectory,
  useOverview, useProxyPolicies, useProxyStatus, useRuns, useSpendByMember, useSpendByModel, useSpendDaily,
  type Run,
} from './data/use-company'

type Props = { replay: number; toast: (m: string) => void; go: (screen: string) => void }

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)

/** "27 Jul" — the axis wants a day, not an ISO string. */
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/**
 * Audit actions are dotted machine names. This turns the common ones into a
 * sentence and leaves anything unrecognised legible rather than blank, so a new
 * backend action never renders as an empty row.
 */
const CHANNEL_LABEL: Record<string, string> = { lark: 'Lark', desktop: 'Desktop', api: 'API' }
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
  const { data: overview } = useOverview(30)
  const { data: daily } = useSpendDaily(14)
  const { data: memberSpend } = useSpendByMember(30)
  const { data: directory } = useDirectory()
  const { data: departments } = useCompanyDepartments()
  const { spend: deptSpend } = useDepartmentSpend(departments, 30)
  const { data: audit } = useAuditLog(6)

  const days = daily.series.map((point) => ({ label: shortDate(point.date), v: point.spendUsd }))
  const last7 = sum(days.slice(-7).map((d) => d.v))
  const prev7 = sum(days.slice(0, Math.max(days.length - 7, 0)).map((d) => d.v))
  const active = departments.filter((d) => d.status === 'active')
  const unmanaged = active.filter((d) => d.managerCount === 0)
  const overBudget = memberSpend.members.filter((m) => m.usagePct >= 85)
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
          {!r1 ? <SkelRows n={3} icon={false} /> : attention.length === 0 ? (
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
                    rate — {daily.cacheSavingsPct}% of input tokens were served from cache in this window.
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
                      <div className="ws-row click" key={d.id} onClick={() => go('co-departments')}>
                        <span className="ws-ic" data-tone={d.managerCount ? undefined : 'warn'}><Building2 size={14} /></span>
                        <div className="ws-row-main">
                          <b>{d.name}</b>
                          <p>{d.memberCount} people · {d.managerCount ? `${d.managerCount} manager${d.managerCount > 1 ? 's' : ''}` : 'no manager'}</p>
                          <div style={{ marginTop: 9, maxWidth: 300 }}>
                            <Bar pct={share} tone={share > 40 ? 'brand' : undefined} />
                          </div>
                        </div>
                        <span className="ws-sub">{money(spent)}</span>
                      </div>
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

/* ══ The company ceiling ═══════════════════════════════
   The one screen that explains the whole permission model: this is the
   ceiling, teams grant beneath it, and a team grant above it silently does
   nothing. Placing it in the same app as the team matrix is the point. */
export function CompanyPolicy({ replay, toast }: Props) {
  const [r1] = useStaged([300], replay)
  const [role, setRole] = useState<'MEMBER' | 'COMPANY_ADMIN'>('MEMBER')

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Company ceiling"
        description="The highest anything can go. A department manager grants within this — never above it."
      />
      <div className="ws-stack">
        <div className="ws-ceiling">
          <TriangleAlert size={14} />
          <div>
            <b>Turning something off here overrides every team.</b>{' '}
            A manager who has already granted it will see the permission go quiet rather than disappear — which is
            why the team screens show a lock and explain it, instead of failing later.
          </div>
        </div>

        <div className="filters">
          <Seg
            value={role}
            onChange={setRole}
            options={[{ value: 'MEMBER', label: 'Everyone' }, { value: 'COMPANY_ADMIN', label: 'Admins' }]}
          />
        </div>

        <Panel title="What may be granted at all" source="permissions">
          {!r1 ? <SkelRows n={6} icon={false} /> : (
            <Fade>
              <div style={{ overflowX: 'auto' }}>
                <table className="ws-matrix">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      {ACTION_GROUPS.map((a) => <th key={a} className="act">{a}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {TOOLS.map((tool) => (
                      <tr key={tool.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                            <span style={{ fontWeight: 500 }}>{tool.name}</span>
                            <span className="ws-sub">{tool.family}</span>
                            {tool.adminOnly ? <span className="ws-tag"><Lock size={10} />Admins</span> : null}
                          </div>
                        </td>
                        {ACTION_GROUPS.map((action) => {
                          const supported = tool.actions.includes(action)
                          if (!supported) return <td key={action} className="act"><span className="ws-cell-na">·</span></td>
                          const on = (COMPANY_CEILING[tool.id] ?? []).includes(action as ActionGroup)
                          const forbidden = role === 'MEMBER' && tool.adminOnly
                          return (
                            <td key={action} className="act">
                              <button
                                type="button"
                                className="ws-cell"
                                data-on={on && !forbidden}
                                data-locked={forbidden}
                                disabled={forbidden}
                                title={forbidden ? 'This tool is admin-only by design' : on ? 'Teams may grant this' : 'No team may grant this'}
                                onClick={() => toast(`${on ? 'Blocked' : 'Allowed'} ${action} on ${tool.name}`)}
                              >
                                {forbidden ? <Lock size={11} /> : on ? <Check size={13} /> : null}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            Deleting mail and deleting Airtable records are off company-wide — no team can turn them on.
          </div>
        </Panel>
      </div>
    </>
  )
}

/* ══ Directory ═════════════════════════════════════════ */
export function CompanyPeople({ replay, go }: Props) {
  const { session } = useAdminAuth()
  const [r1] = useStaged([300], replay)
  const [query, setQuery] = useState('')
  const { data: directory, loading } = useDirectory()
  const { data: memberSpend } = useSpendByMember(30)

  const spendByUser = new Map(memberSpend.members.map((m) => [m.userId, m]))
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
            style={{ border: 0, background: 'none', outline: 'none', flex: 1, fontSize: 13, color: 'var(--cur-ink)', fontFamily: 'inherit' }}
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
                  <div className="ws-row click" key={p.userId} onClick={() => go(`co-person:${p.userId}`)}>
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
                  </div>
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
  const { data: departments, loading } = useCompanyDepartments()
  const active = departments.filter((d) => d.status === 'active')
  const { spend } = useDepartmentSpend(active, 30)

  return (
    <>
      <PageHeader
        eyebrow={session?.companyName ?? 'Company'}
        title="Departments"
        description="A department is the only unit below the company. Its manager is whoever holds the Manager role in it."
        actions={<button type="button" className="btn primary" onClick={() => toast('Creating a department is not wired to this screen yet')}>New department</button>}
      />
      <Panel source="teamPeople">
        {!r1 || loading ? <SkelRows n={4} /> : active.length === 0 ? (
          <Empty icon={Building2} title="No departments yet" body="Every person needs a department before Divo can grant them anything." />
        ) : (
          <Fade>
            <div className="ws-rows">
              {active.map((d) => (
                <div className="ws-row click" key={d.id} onClick={() => go(`co-department:${d.id}`)}>
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
                </div>
              ))}
            </div>
          </Fade>
        )}
        <div className="ws-panel-foot">
          There are no reporting lines in Divo — "manager" means holding the Manager role in a department, nothing more.
        </div>
      </Panel>
    </>
  )
}

/* ══ Company connections ═══════════════════════════════
   Two different questions, kept apart. "What has the company connected" is a
   config list. "Who is about to break" is coverage — and it is the one that
   costs a day of failed runs when nobody looks at it. */

type Coverage = {
  provider: (typeof CONNECTORS)[number]['provider']
  name: string
  connected: number
  expiring: number
  never: number
  missing: string[]
  lastUsed: string
}

const COVERAGE: Coverage[] = [
  {
    provider: 'lark', name: 'Lark', connected: 46, expiring: 0, never: 2, lastUsed: 'Just now',
    missing: ['Meera Rao', 'Dinesh Pillai'],
  },
  {
    provider: 'google_workspace', name: 'Google Workspace', connected: 27, expiring: 4, never: 17, lastUsed: '3 minutes ago',
    missing: ['Meera Rao', 'Kabir Shah', 'Nikhil Roy', 'Farah Khan', 'and 13 others'],
  },
  {
    provider: 'airtable', name: 'Airtable', connected: 6, expiring: 0, never: 42, lastUsed: '2 days ago',
    missing: ['Everyone outside Finance and Operations'],
  },
  {
    provider: 'canva', name: 'Canva', connected: 11, expiring: 1, never: 36, lastUsed: 'Yesterday', missing: ['Mostly Sales — 8 of 19 connected'],
  },
]

export function CompanyConnections({ replay, toast }: Props) {
  const [r1, r2] = useStaged([260, 520], replay)
  const [open, setOpen] = useState<string | null>(null)
  const totalPeople = 48
  const expiring = sum(COVERAGE.map((c) => c.expiring))

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Connections"
        description="What the company connected once for everyone, and how much of the company is actually connected. Personal connections stay private to whoever made them — you can see that one exists, never its contents."
      />
      <div className="ws-stack">
        <Panel title="Connected for the company" source="companyConnections">
          {!r1 ? <SkelRows n={3} /> : (
            <Fade>
              <div className="ws-rows">
                {CONNECTORS.filter((c) => !c.memberCanConnect).map((c) => (
                  <div className="ws-row click" key={c.provider} onClick={() => toast(`Manage ${c.name}`)}>
                    <ProviderMark provider={c.provider} />
                    <div className="ws-row-main">
                      <b>{c.name}</b>
                      <p>{c.blurb} · {c.auth} · added by Dev Kapoor</p>
                    </div>
                    <div className="ws-row-act">
                      <span className="ws-sub">Used 2 hours ago</span>
                      <span className="badge b-ok"><span className="dot" />On</span>
                    </div>
                  </div>
                ))}
                <div className="ws-row click" onClick={() => toast('Manage web search')}>
                  <span className="ws-ic"><KeyRound size={14} /></span>
                  <div className="ws-row-main">
                    <b>Web search</b>
                    <p>Company API key · 41,200 credits remaining · every department</p>
                  </div>
                  <div className="ws-row-act">
                    <span className="ws-sub">Used 6 minutes ago</span>
                    <span className="badge b-ok"><span className="dot" />On</span>
                  </div>
                </div>
              </div>
            </Fade>
          )}
        </Panel>

        <Panel
          title="Coverage"
          description={`How much of the company can actually use each connector${expiring ? ` · ${expiring} tokens expire within a week` : ''}`}
          source="connectionCoverage"
        >
          {!r2 ? <SkelRows n={4} /> : (
            <Fade>
              <div className="ws-rows">
                {COVERAGE.map((c) => {
                  const isOpen = open === c.provider
                  return (
                    <div className="ws-row" key={c.provider} style={{ alignItems: 'flex-start' }}>
                      <ProviderMark provider={c.provider} />
                      <div className="ws-row-main">
                        <b>
                          {c.name}
                          {c.expiring > 0 ? <span className="ws-prov" data-src="department_user_override">{c.expiring} expiring</span> : null}
                        </b>
                        <p>{c.connected} of {totalPeople} connected · last used {c.lastUsed}</p>
                        <div style={{ marginTop: 10, maxWidth: 380 }}>
                          <div className="ws-hbar">
                            <i data-k="ok" style={{ width: `${((c.connected - c.expiring) / totalPeople) * 100}%` }} />
                            <i data-k="soon" style={{ width: `${(c.expiring / totalPeople) * 100}%` }} />
                            <i data-k="none" style={{ width: `${(c.never / totalPeople) * 100}%` }} />
                          </div>
                          <div className="ws-hkey">
                            <span><i style={{ background: 'var(--cur-success)' }} />{c.connected - c.expiring} working</span>
                            {c.expiring ? <span><i style={{ background: 'var(--ws-warning)' }} />{c.expiring} expiring</span> : null}
                            <span><i style={{ background: 'var(--cur-hairline-strong)' }} />{c.never} never connected</span>
                          </div>
                        </div>
                        {isOpen ? (
                          <div className="ws-ba">
                            <div className="ws-lbl">Not connected</div>
                            {c.missing.map((m) => (
                              <div className="ws-ba-r" key={m}><span className="to">{m}</span></div>
                            ))}
                          </div>
                        ) : null}
                        <div style={{ marginTop: 11 }}>
                          <button
                            type="button"
                            className="ws-more"
                            data-open={isOpen}
                            onClick={() => setOpen(isOpen ? null : c.provider)}
                          >
                            <ChevronRight size={13} />{isOpen ? 'Hide' : 'Who is missing'}
                          </button>
                        </div>
                      </div>
                      <button type="button" className="btn" onClick={() => toast('Reminder sent in Lark')}>Ask them</button>
                    </div>
                  )
                })}
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            <ShieldCheck size={13} />
            You can set rate limits and approval rules on these — you cannot read their contents or tokens.
          </div>
        </Panel>
      </div>
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
type AuditKind = 'permission' | 'member' | 'connection' | 'approval' | 'other'

const KIND_LABEL: Record<AuditKind, string> = {
  permission: 'Permissions',
  member: 'People',
  connection: 'Connections',
  approval: 'Approvals',
  other: 'Other',
}

const kindOf = (action: string): AuditKind => {
  if (action.startsWith('permission.')) return 'permission'
  if (action.includes('membership') || action.includes('member') || action.includes('invite')) return 'member'
  if (action.includes('connection')) return 'connection'
  if (action.includes('approval')) return 'approval'
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
  const { data: entries, loading } = useAuditLog(200)
  const { data: directory } = useDirectory()

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
        description="Who changed what. Every permission grant, connection and approval decision is recorded — including the ones that quietly overrode somebody else."
      />

      <div className="filters">
        <div className="search" style={{ maxWidth: 260 }}>
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search changes"
            style={{ border: 0, background: 'none', outline: 'none', flex: 1, fontSize: 13, color: 'var(--cur-ink)', fontFamily: 'inherit' }}
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
            data-empty={!counts[k]}
            onClick={() => toggleKind(k)}
          >
            {KIND_LABEL[k]}<span className="n">{counts[k] ?? 0}</span>
          </button>
        ))}
        {filtered ? (
          <button type="button" className="btn ws-filter-x" onClick={() => { setKinds([]); setActor('all'); setQuery('') }}>
            Clear
          </button>
        ) : null}
      </div>

      <Panel>
        <div className="ws-sum">
          <span><b>{list.length}</b> of {entries.length} changes</span>
          <span className="sep" />
          <span><b>{new Set(list.map((e) => e.actorId)).size}</b> people</span>
        </div>
        {!r1 || loading ? <SkelRows n={6} icon={false} /> : list.length === 0 ? (
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
          Written on every permission change. Reads are never recorded, so an empty day means nothing was altered.
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

type CoRun = {
  id: string
  who: string
  initials: string
  dept: string
  summary: string
  channel: 'lark' | 'desktop'
  status: 'completed' | 'running' | 'failed'
  day: string
  when: string
  dur: string | null
  cost: number
  fail?: string
}

const CO_RUNS: CoRun[] = [
  { id: 'r2211', who: 'Rohan Iyer', initials: 'RI', dept: 'Finance', summary: 'Reconciled the March vendor ledger', channel: 'lark', status: 'running', day: 'Today', when: '4 min ago', dur: null, cost: 0.21 },
  { id: 'r2210', who: 'Ananya Mehta', initials: 'AM', dept: 'Finance', summary: 'Drafted 14 supplier reminders', channel: 'desktop', status: 'completed', day: 'Today', when: '2 hours ago', dur: '3m 41s', cost: 0.38 },
  { id: 'r2209', who: 'Vikram Desai', initials: 'VD', dept: 'Sales', summary: 'Built the Q3 pipeline review deck', channel: 'desktop', status: 'completed', day: 'Today', when: '3 hours ago', dur: '8m 12s', cost: 1.64 },
  { id: 'r2208', who: 'Kabir Shah', initials: 'KS', dept: 'Finance', summary: 'Looked up supplier GST numbers', channel: 'desktop', status: 'failed', day: 'Today', when: '4 hours ago', dur: '0m 22s', cost: 0.02, fail: 'Tool not permitted' },
  { id: 'r2207', who: 'Priya Nair', initials: 'PN', dept: 'Finance', summary: 'Built the Q2 expense breakdown', channel: 'desktop', status: 'completed', day: 'Today', when: '5 hours ago', dur: '6m 02s', cost: 0.71 },
  { id: 'r2206', who: 'Sana Qureshi', initials: 'SQ', dept: 'Operations', summary: 'Chased three shipment delays', channel: 'lark', status: 'running', day: 'Today', when: '6 hours ago', dur: null, cost: 0.14 },
  { id: 'r2205', who: 'Farah Khan', initials: 'FK', dept: 'Sales', summary: 'Pulled last quarter’s win rates', channel: 'lark', status: 'failed', day: 'Today', when: '7 hours ago', dur: '0m 08s', cost: 0, fail: 'Provider returned 401 — token expired' },
  { id: 'r2204', who: 'Meera Rao', initials: 'MR', dept: 'People', summary: 'Assembled the new-joiner checklist', channel: 'lark', status: 'failed', day: 'Yesterday', when: '19:22', dur: '0m 11s', cost: 0, fail: 'Approval expired before anyone answered' },
  { id: 'r2203', who: 'Vikram Desai', initials: 'VD', dept: 'Sales', summary: 'Wrote 22 follow-up emails after the expo', channel: 'desktop', status: 'completed', day: 'Yesterday', when: '17:05', dur: '11m 38s', cost: 2.41 },
  { id: 'r2202', who: 'Rohan Iyer', initials: 'RI', dept: 'Finance', summary: 'Re-read the ledger sheet eleven times', channel: 'desktop', status: 'completed', day: 'Yesterday', when: '14:11', dur: '21m 04s', cost: 41.2 },
  { id: 'r2201', who: 'Nikhil Roy', initials: 'NR', dept: 'Operations', summary: 'Checked three vendor GST filings', channel: 'desktop', status: 'failed', day: 'Yesterday', when: '11:40', dur: '0m 19s', cost: 0.01, fail: 'Tool not permitted' },
  { id: 'r2200', who: 'Ananya Mehta', initials: 'AM', dept: 'Finance', summary: 'Summarised the audit thread', channel: 'lark', status: 'running', day: 'Yesterday', when: '10:02', dur: null, cost: 0.09 },
  { id: 'r2199', who: 'Farah Khan', initials: 'FK', dept: 'Sales', summary: 'Built a prospect list from the web', channel: 'desktop', status: 'failed', day: 'Yesterday', when: '09:14', dur: '1m 02s', cost: 0.44, fail: 'Model budget reached (402)' },
  { id: 'r2198', who: 'Kabir Shah', initials: 'KS', dept: 'Finance', summary: 'Filed the month-close checklist', channel: 'desktop', status: 'failed', day: 'Yesterday', when: '08:31', dur: '0m 06s', cost: 0, fail: 'Provider returned 401 — token expired' },
]

const FAIL_FIX: Record<string, string> = {
  'Tool not permitted': 'The person asked for something their role does not grant. Either grant it or the skill should stop offering it.',
  'Provider returned 401 — token expired': 'Their connection lapsed. Divo cannot tell them why, so the run just dies — ask them to reconnect.',
  'Approval expired before anyone answered': 'A manager was asked and nobody replied within the hour. The department has no second approver.',
  'Model budget reached (402)': 'The proxy refused mid-run. The work is lost, not queued.',
}

const MODEL_SPEND = [
  { model: 'deepseek-v4-flash', label: 'Flash', calls: 4820, cost: 34.11 },
  { model: 'deepseek-v4-pro', label: 'Pro', calls: 962, cost: 118.42 },
  { model: 'gpt-5.6-luna', label: 'Luna', calls: 114, cost: 21.55 },
]

/* ══ AI Ops ════════════════════════════════════════════ */
export function CompanyAiOps({ replay, go }: Props) {
  const { session } = useAdminAuth()
  const [r1, r2] = useStaged([280, 560], replay)
  const [tab, setTab] = useState<'runs' | 'failures' | 'cost'>('runs')
  const [channels, setChannels] = useState<string[]>([])
  const [statuses, setStatuses] = useState<string[]>([])
  const [query, setQuery] = useState('')

  const { data: runs, loading } = useRuns({ limit: 200 })
  const { data: byModel } = useSpendByModel(30)
  const { data: departments } = useCompanyDepartments()
  const activeDepts = departments.filter((d) => d.status === 'active')
  const { spend: deptSpend } = useDepartmentSpend(activeDepts, 30)
  const { data: desktopSpend } = useSpendDaily(30, 'desktop')
  const { data: larkSpend } = useSpendDaily(30, 'lark')

  const list = runs.filter((r) => {
    if (channels.length && !channels.includes(r.channel)) return false
    if (statuses.length && !statuses.includes(r.status)) return false
    if (query && !`${r.latestSummary ?? ''} ${r.userName ?? ''}`.toLowerCase().includes(query.toLowerCase())) return false
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
                style={{ border: 0, background: 'none', outline: 'none', flex: 1, fontSize: 13, color: 'var(--cur-ink)', fontFamily: 'inherit' }}
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
            <div className="ws-sum">
              <span><b>{list.length}</b> runs</span>
              <span className="sep" />
              <span><b>{money(sum(list.map(runCost)))}</b> spent</span>
              <span className="sep" />
              <span><b>{list.filter((r) => r.status === 'failed').length}</b> failed</span>
              <span className="sep" />
              <span><b>{list.filter((r) => r.status === 'running').length}</b> still open</span>
            </div>
            {!r1 || loading ? <SkelRows n={6} /> : list.length === 0 ? (
              <Empty title="No runs match" body={filtered ? 'Widen the filter.' : 'Nothing has run yet.'} />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {Array.from(new Set(list.map((r) => onDay(r.startedAt)))).map((day) => (
                    <Fragment key={day}>
                      <div className="ws-day">{day}</div>
                      {list.filter((r) => onDay(r.startedAt) === day).map((r) => (
                        <div className="ws-row click" key={r.id} onClick={() => go(`co-run:${r.id}`)}>
                          <span className="avatar">{initialsOf(r.userName, r.userName ?? '?')}</span>
                          <div className="ws-row-main">
                            <b>
                              {r.latestSummary ?? 'No summary recorded'}
                              {r.status === 'running' && r.channel === 'lark' ? (
                                <span className="ws-note" title="The LLM proxy creates Lark runs and never closes them, so status and duration are unreliable for this channel.">
                                  status unknown
                                </span>
                              ) : null}
                            </b>
                            <p>
                              {r.userName ?? 'Unattributed'} · {ago(r.startedAt)} · {CHANNEL_LABEL[r.channel] ?? r.channel}
                              {durationLabel(r.durationMs) ? ` · ${durationLabel(r.durationMs)}` : ''}
                              {r.errorCode ? ` · ${r.errorCode}` : ''}
                            </p>
                          </div>
                          <div className="ws-row-act">
                            {/* Null cost means nothing was attributed to this run, which is
                                not the same as free — so it says so rather than showing $0.00. */}
                            <span className="ws-sub">{r.costUsd === null ? 'unattributed' : money(r.costUsd)}</span>
                            <RunBadge status={r.status} />
                          </div>
                        </div>
                      ))}
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
                        tone={totalModel > 0 && m.costUsd / totalModel > 0.4 ? 'brand' : undefined}
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
                  <div className="ws-metrics" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div className="ws-metric">
                      <div className="k">Desktop</div>
                      <div className="v">{money(sum(desktopSpend.series.map((p) => p.spendUsd)))}</div>
                      <div className="s">Longer tasks, higher cost each</div>
                    </div>
                    <div className="ws-metric">
                      <div className="k">Lark</div>
                      <div className="v">{money(sum(larkSpend.series.map((p) => p.spendUsd)))}</div>
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
  const { data: deepseek } = useProxyStatus('deepseek')
  const { data: openai } = useProxyStatus('openai')
  const { data: memberSpend } = useSpendByMember(30)
  const { data: policies, setPolicy } = useProxyPolicies()

  const policyFor = (userId: string) => policies.find((p) => p.userId === userId)
  const keys = [
    { provider: 'DeepSeek', status: deepseek },
    { provider: 'OpenAI', status: openai },
  ]

  const toggleBlocked = async (userId: string, name: string, nowBlocked: boolean) => {
    try {
      await setPolicy(userId, { blocked: !nowBlocked })
      toast(nowBlocked ? `${name} unblocked` : `${name} blocked`)
    } catch {
      toast('Could not change that limit')
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
        <Panel title="Provider keys" description="Held encrypted by the backend, never returned to any client">
          {!r1 ? <SkelRows n={2} /> : (
            <Fade>
              <div className="ws-rows">
                {keys.map(({ provider, status }) => (
                  <div className="ws-row" key={provider}>
                    <span className="ws-ic" data-tone={status?.keyError ? 'err' : status?.configured ? 'ok' : undefined}>
                      <KeyRound size={14} />
                    </span>
                    <div className="ws-row-main">
                      <b>
                        {provider}
                        {status?.scope === 'platform' ? <span className="ws-tag">Platform</span> : null}
                      </b>
                      <p>
                        {/* A key that exists but will not decrypt is the failure worth naming:
                            everything looks configured and every call 401s. */}
                        {status?.keyError === 'unreadable'
                          ? 'Stored but unreadable — the encryption secret has changed, so every call will fail'
                          : status?.configured
                            ? `${status.scope === 'platform' ? 'Platform' : 'Company'} key · ${status.keyMasked ?? status.keyLast4 ?? '····'} · ${status.upstream}`
                            : 'Not configured'}
                      </p>
                    </div>
                    <button type="button" className="btn" onClick={() => toast(`Key management for ${provider} is not on this screen yet`)}>
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
          {!r1 ? <SkelRows n={4} /> : memberSpend.members.length === 0 ? (
            <Empty title="Nobody has spent anything yet" body="Limits appear here once someone starts using Divo." />
          ) : (
            <Fade>
              <div className="ws-rows">
                {memberSpend.members.slice(0, 12).map((m) => {
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
                            <Bar pct={(m.spend30d / budget) * 100} tone={m.spend30d / budget > 0.8 ? 'brand' : undefined} />
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
    </>
  )
}

/* ══ Skills ════════════════════════════════════════════ */
export function CompanySkills({ replay, toast, go }: Props) {
  const [r1] = useStaged([300], replay)
  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Skills"
        description="Saved ways of working, and who may run each one. A skill stays invisible until someone is granted it and holds every tool it needs."
        actions={<button type="button" className="btn" onClick={() => toast('New folder')}><Plus size={14} />New folder</button>}
      />
      <Panel source="skills">
        {!r1 ? <SkelRows n={5} /> : (
          <Fade>
            <div className="ws-rows">
              {SKILLS.map((s) => (
                <div className="ws-row click" key={s.id} onClick={() => go('co-skill')}>
                  <span className="ws-ic"><Sparkles size={14} /></span>
                  <div className="ws-row-main">
                    <b>{s.name}<span className="ws-tag">{s.scope}</span></b>
                    <p>
                      {s.blurb} · needs {s.tools.map((t) => toolById(t)?.name).filter(Boolean).join(', ')}
                    </p>
                  </div>
                  <div className="ws-row-act">
                    <span className="ws-sub">{s.runs30d} runs</span>
                    <span className="ws-sub">{s.owner}</span>
                  </div>
                </div>
              ))}
            </div>
          </Fade>
        )}
        <div className="ws-panel-foot">
          Access is a grant per user, department, role or company — deny by default, exactly like connections
        </div>
      </Panel>
    </>
  )
}

/* ══ Memory ════════════════════════════════════════════ */
export function CompanyMemory({ replay, toast }: Props) {
  const [r1] = useStaged([300], replay)
  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Memory"
        description="What Divo has learned that applies beyond one person. Personal memories stay private to whoever taught them."
      />
      <Panel>
        {!r1 ? <SkelRows n={4} /> : (
          <Fade>
            <div className="ws-rows">
              {MEMORIES.filter((m) => m.scope !== 'personal').map((m) => (
                <div className="ws-row" key={m.id}>
                  <span className="ws-ic"><Brain size={14} /></span>
                  <div className="ws-row-main">
                    <b style={{ fontWeight: 400 }}>{m.text}</b>
                    <p>{m.scope === 'department' ? 'Everyone in Finance' : 'Everyone at Acme'} · learned {m.learned} · used {m.usedCount} times</p>
                  </div>
                  <button type="button" className="btn" onClick={() => toast('Forgotten')}><Trash2 size={14} />Forget</button>
                </div>
              ))}
            </div>
          </Fade>
        )}
        <div className="ws-panel-foot">
          <TriangleAlert size={13} />
          Memory is being reworked separately — treat this screen as a placeholder and do not wire it yet
        </div>
      </Panel>
    </>
  )
}
