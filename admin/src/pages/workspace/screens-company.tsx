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
  Switch, money, useStaged,
} from './ui'

type Props = { replay: number; toast: (m: string) => void; go: (screen: string) => void }

/* ── Shared company fixtures ─────────────────────────── */

const DEPARTMENTS = [
  { id: 'd_finance', name: 'Finance', people: 6, manager: 'Arjun Shah', spend: 102.21, prev: 78.4, roles: 3 },
  { id: 'd_ops', name: 'Operations', people: 11, manager: 'Sana Qureshi', spend: 188.4, prev: 191.2, roles: 4 },
  { id: 'd_sales', name: 'Sales', people: 19, manager: 'Vikram Desai', spend: 341.07, prev: 240.6, roles: 2 },
  { id: 'd_people', name: 'People', people: 4, manager: null, spend: 22.8, prev: 19.9, roles: 2 },
]

/** Fourteen days ending today. The spike on 27 Jul is deliberate — it is what
    the overview has to be able to explain without anyone opening five screens. */
const SPEND_DAYS = [
  { label: '19 Jul', v: 14.2 }, { label: '20 Jul', v: 19.8 }, { label: '21 Jul', v: 16.1 },
  { label: '22 Jul', v: 22.4 }, { label: '23 Jul', v: 12.9 }, { label: '24 Jul', v: 6.2 },
  { label: '25 Jul', v: 4.8 }, { label: '26 Jul', v: 21.6 }, { label: '27 Jul', v: 68.4 },
  { label: '28 Jul', v: 24.9 }, { label: '29 Jul', v: 26.1 }, { label: '30 Jul', v: 31.7 },
  { label: '31 Jul', v: 9.4 }, { label: '1 Aug', v: 7.1 },
]

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)
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
  const [r1, r2, r3] = useStaged([240, 480, 700], replay)

  const last7 = sum(SPEND_DAYS.slice(-7).map((d) => d.v))
  const prev7 = sum(SPEND_DAYS.slice(0, 7).map((d) => d.v))
  const spendDelta = pctChange(last7, prev7)
  const noManager = DEPARTMENTS.filter((d) => !d.manager)
  const totalSpend = sum(DEPARTMENTS.map((d) => d.spend))

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Company"
        description="Forty-eight people across four departments. You set the ceiling every team works within."
      />
      <div className="ws-stack">
        <Panel title="Needs you">
          {!r1 ? <SkelRows n={3} icon={false} /> : (
            <Fade>
              <div className="ws-attn">
                {noManager.map((d) => (
                  <div className="ws-attn-item" data-tone="warn" key={d.id}>
                    <span className="ws-attn-bar" />
                    <div className="ws-attn-main">
                      <b>{d.name} has no manager</b>
                      <p>
                        Nobody can approve risky actions for these {d.people} people, so Divo fails closed and
                        anything gated simply stops.
                      </p>
                      <div className="ws-attn-meta"><span>{d.people} people affected</span><span>Since 12 June</span></div>
                    </div>
                    <button type="button" className="btn" onClick={() => go('co-departments')}>Assign</button>
                  </div>
                ))}
                <div className="ws-attn-item" data-tone="act">
                  <span className="ws-attn-bar" />
                  <div className="ws-attn-main">
                    <b>Two access requests are waiting on a manager</b>
                    <p>Both have been outstanding for more than a day. Requests expire silently, and the person who asked is never told.</p>
                    <div className="ws-attn-meta"><span>Finance · Operations</span><span>Oldest: 31 hours</span></div>
                  </div>
                  <button type="button" className="btn" onClick={() => go('co-people')}>Review</button>
                </div>
                <div className="ws-attn-item" data-tone="warn">
                  <span className="ws-attn-bar" />
                  <div className="ws-attn-main">
                    <b>Four Google connections expire within a week</b>
                    <p>
                      When a token lapses, every run that needed it fails with a 401 and Divo cannot tell the person
                      why. They have to be asked to reconnect before it happens.
                    </p>
                    <div className="ws-attn-meta"><span>Sales · Operations</span><span>Earliest: 4 days</span></div>
                  </div>
                  <button type="button" className="btn" onClick={() => go('co-connections')}>See who</button>
                </div>
                <div className="ws-attn-item" data-tone="act">
                  <span className="ws-attn-bar" />
                  <div className="ws-attn-main">
                    <b>Rohan Iyer is at 92% of his monthly budget</b>
                    <p>At the current rate he is blocked in four days. The proxy returns 402 and the run stops mid-task.</p>
                    <div className="ws-attn-meta"><span>$36.80 of $40.00</span><span>Finance</span></div>
                  </div>
                  <button type="button" className="btn" onClick={() => go('co-guardrails')}>Raise it</button>
                </div>
              </div>
            </Fade>
          )}
        </Panel>

        <Panel title="This week">
          {!r2 ? (
            <div className="ws-panel-body"><Skel w="100%" h={72} /></div>
          ) : (
            <Fade>
              <div className="ws-metrics">
                <div className="ws-metric">
                  <div className="k">Spend</div>
                  <div className="v">{money(last7)}<Delta pct={spendDelta} tone="warn" /></div>
                  <div className="s">Last 7 days, against the 7 before</div>
                </div>
                <div className="ws-metric">
                  <div className="k">Runs</div>
                  <div className="v">1,204<Delta pct={12} /></div>
                  <div className="s">Across Lark and desktop</div>
                </div>
                <div className="ws-metric">
                  <div className="k">People active</div>
                  <div className="v">38<span className="ws-sub">of 48</span></div>
                  <div className="s">Ten have never run anything</div>
                </div>
                <div className="ws-metric">
                  <div className="k">Failed runs</div>
                  <div className="v">22<Delta pct={-29} tone="good" /></div>
                  <div className="s">Mostly expired tokens</div>
                </div>
              </div>
            </Fade>
          )}
          <div className="ws-panel-body" style={{ borderTop: '1px solid var(--cur-hairline)' }}>
            {!r2 ? <Skel w="100%" h={118} /> : (
              <Fade>
                <div className="ws-lbl">Spend per day</div>
                <div style={{ marginTop: 14 }}>
                  <DayChart days={SPEND_DAYS} hotFrom={7} />
                </div>
                <div className="ws-why">
                  <Info size={14} />
                  <div>
                    <b>27 July is three times any other day, and one run did it.</b>{' '}
                    Rohan's ledger reconciliation re-read the same 200-row sheet eleven times, because the sheet tool
                    reads whole tabs and has no pagination. It cost $41.20 of that day's $68.40.{' '}
                    <button type="button" onClick={() => go('co-run')}>Open the run</button>
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
            {!r3 ? <SkelRows n={4} /> : (
              <Fade>
                <div className="ws-rows">
                  {DEPARTMENTS.map((d) => {
                    const delta = pctChange(d.spend, d.prev)
                    return (
                      <div className="ws-row click" key={d.id} onClick={() => go('co-department')}>
                        <span className="ws-ic" data-tone={d.manager ? undefined : 'warn'}><Building2 size={14} /></span>
                        <div className="ws-row-main">
                          <b>{d.name}<Delta pct={delta} tone={delta > 25 ? 'warn' : undefined} /></b>
                          <p>{d.people} people · {d.manager ? `led by ${d.manager}` : 'no manager'}</p>
                          <div style={{ marginTop: 9, maxWidth: 300 }}>
                            <Bar pct={(d.spend / totalSpend) * 100} tone={d.spend / totalSpend > 0.4 ? 'brand' : undefined} />
                          </div>
                        </div>
                        <span className="ws-sub">{money(d.spend)}</span>
                      </div>
                    )
                  })}
                </div>
              </Fade>
            )}
            <div className="ws-panel-foot">
              Sales is 52% of company spend on 40% of the people — its deck-building skill runs on the expensive model
            </div>
          </Panel>

          <Panel
            title="Latest changes"
            aside={<button type="button" className="btn" onClick={() => go('co-audit')}>All activity</button>}
          >
            {!r3 ? <SkelRows n={4} icon={false} /> : (
              <Fade>
                <div className="ws-rows">
                  {AUDIT.slice(0, 4).map((a) => (
                    <div className="ws-row" key={a.id}>
                      <div className="ws-row-main">
                        <b style={{ fontWeight: 400 }}>{a.what}</b>
                        <p>{a.who} · {a.when}</p>
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
  const [r1] = useStaged([300], replay)
  const [query, setQuery] = useState('')
  const list = PEOPLE.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
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
        {!r1 ? <SkelRows n={6} /> : list.length === 0 ? (
          <Empty icon={Users} title="Nobody matches" />
        ) : (
          <Fade>
            <div className="ws-rows">
              {list.map((p) => (
                <div className="ws-row click" key={p.id} onClick={() => go('co-person')}>
                  <span className="avatar">{p.initials}</span>
                  <div className="ws-row-main">
                    <b>{p.name}{p.deptRole === 'MANAGER' ? <span className="ws-tag">Manager</span> : null}</b>
                    <p>{p.title} · Finance · {p.companyRole === 'MEMBER' ? 'Member' : 'Company admin'}</p>
                  </div>
                  <div className="ws-row-act">
                    <span className="ws-sub">{money(p.spend30d)}</span>
                    <span className="ws-sub">{p.lastActive}</span>
                  </div>
                </div>
              ))}
            </div>
          </Fade>
        )}
      </Panel>
    </>
  )
}

/* ══ Departments ═══════════════════════════════════════ */
export function CompanyDepartments({ replay, toast, go }: Props) {
  const [r1] = useStaged([280], replay)
  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Departments"
        description="A department is the only unit below the company. Its manager is whoever holds the Manager role in it."
        actions={<button type="button" className="btn primary" onClick={() => toast('New department')}>New department</button>}
      />
      <Panel source="teamPeople">
        {!r1 ? <SkelRows n={4} /> : (
          <Fade>
            <div className="ws-rows">
              {DEPARTMENTS.map((d) => (
                <div className="ws-row click" key={d.id} onClick={() => go('co-department')}>
                  <span className="ws-ic" data-tone={d.manager ? undefined : 'warn'}><Building2 size={14} /></span>
                  <div className="ws-row-main">
                    <b>{d.name}{!d.manager ? <span className="ws-prov" data-src="department_user_override">No manager</span> : null}</b>
                    <p>{d.people} people · {d.roles} roles · {d.manager ? `led by ${d.manager}` : 'nobody can approve for this team'}</p>
                  </div>
                  <span className="ws-sub">{money(d.spend)}</span>
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
        <Panel title="Connected for the company" source="connections">
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
          source="reconnect"
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
   entry expands into what the value was and what it became. */

type AuditKind = 'permission' | 'ceiling' | 'connection' | 'approval' | 'role' | 'member' | 'budget'

type AuditEntry = {
  id: string
  day: string
  when: string
  who: string
  initials: string
  kind: AuditKind
  what: string
  changes: { k: string; from: string; to: string }[]
  note?: string
}

const KIND_LABEL: Record<AuditKind, string> = {
  permission: 'Permission',
  ceiling: 'Company ceiling',
  connection: 'Connection',
  approval: 'Approval',
  role: 'Role',
  member: 'People',
  budget: 'Budget',
}

const AUDIT: AuditEntry[] = [
  {
    id: 'e1', day: 'Today', when: '12 minutes ago', who: 'Arjun Shah', initials: 'AS', kind: 'permission',
    what: 'Gave Ananya Mehta permission to send mail',
    changes: [{ k: 'Gmail · send', from: 'Not granted', to: 'Allowed — personal override' }],
    note: 'A personal override outranks the Member role. It cannot be removed today, only flipped to an explicit deny.',
  },
  {
    id: 'e2', day: 'Today', when: '1 hour ago', who: 'Dev Kapoor', initials: 'DK', kind: 'budget',
    what: "Raised Rohan Iyer's monthly budget",
    changes: [{ k: 'Monthly limit', from: '$40.00', to: '$75.00' }],
  },
  {
    id: 'e3', day: 'Today', when: '2 hours ago', who: 'Dev Kapoor', initials: 'DK', kind: 'ceiling',
    what: 'Raised the company ceiling on Airtable records',
    changes: [{ k: 'Airtable · update', from: 'Blocked company-wide', to: 'Teams may grant' }],
    note: 'Three departments had already granted this. Their grants stopped being silently clamped at this moment.',
  },
  {
    id: 'e4', day: 'Today', when: '4 hours ago', who: 'Sana Qureshi', initials: 'SQ', kind: 'approval',
    what: 'Approved sending 14 supplier reminders',
    changes: [{ k: 'Request from', from: '—', to: 'Rohan Iyer' }, { k: 'Decision', from: 'Waiting', to: 'Approved' }],
  },
  {
    id: 'e5', day: 'Yesterday', when: '18:40', who: 'Rohan Iyer', initials: 'RI', kind: 'connection',
    what: 'Connected Airtable to his own account',
    changes: [{ k: 'Airtable', from: 'Not connected', to: 'Connected · rohan@acme.co' }],
  },
  {
    id: 'e6', day: 'Yesterday', when: '15:02', who: 'Arjun Shah', initials: 'AS', kind: 'approval',
    what: 'Approved a write-off of 6 invoices',
    changes: [{ k: 'Value', from: '—', to: '₹2,14,800' }, { k: 'Decision', from: 'Waiting', to: 'Approved' }],
  },
  {
    id: 'e7', day: 'Yesterday', when: '11:19', who: 'Dev Kapoor', initials: 'DK', kind: 'member',
    what: 'Invited Farah Khan to Sales',
    changes: [{ k: 'Department', from: '—', to: 'Sales' }, { k: 'Role', from: '—', to: 'Member' }],
  },
  {
    id: 'e8', day: 'Yesterday', when: '09:47', who: 'Arjun Shah', initials: 'AS', kind: 'permission',
    what: 'Blocked Priya Nair from editing invoices',
    changes: [{ k: 'Zoho Books · update', from: 'Allowed — Analyst role', to: 'Blocked — personal override' }],
    note: 'The Analyst role still grants this. Priya is the exception, and the exception is what will be enforced.',
  },
  {
    id: 'e9', day: '29 July', when: '16:31', who: 'Sana Qureshi', initials: 'SQ', kind: 'role',
    what: 'Created the "Vendor ops" role in Operations',
    changes: [{ k: 'Tools granted', from: '—', to: 'Zoho Books, Drive, Lark messages' }, { k: 'People', from: '—', to: '4 moved into it' }],
  },
  {
    id: 'e10', day: '29 July', when: '14:08', who: 'Dev Kapoor', initials: 'DK', kind: 'ceiling',
    what: 'Turned off deleting mail company-wide',
    changes: [{ k: 'Gmail · delete', from: 'Teams may grant', to: 'Blocked company-wide' }],
    note: 'Two managers had granted it. Neither was notified — their toggles now show a lock instead.',
  },
  {
    id: 'e11', day: '29 July', when: '10:22', who: 'Vikram Desai', initials: 'VD', kind: 'connection',
    what: 'Revoked the Sales Canva connection',
    changes: [{ k: 'Canva', from: 'Connected · design@acme.co', to: 'Revoked' }],
  },
]

export function CompanyAudit({ replay }: Props) {
  const [r1] = useStaged([300], replay)
  const [kinds, setKinds] = useState<AuditKind[]>([])
  const [actor, setActor] = useState('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const actors = useMemo(() => Array.from(new Set(AUDIT.map((a) => a.who))), [])
  const counts = useMemo(() => {
    const out = {} as Record<AuditKind, number>
    for (const a of AUDIT) out[a.kind] = (out[a.kind] ?? 0) + 1
    return out
  }, [])

  const list = AUDIT.filter((a) => {
    if (kinds.length && !kinds.includes(a.kind)) return false
    if (actor !== 'all' && a.who !== actor) return false
    if (query && !`${a.what} ${a.who}`.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const toggleKind = (k: AuditKind) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))

  const days = Array.from(new Set(list.map((a) => a.day)))
  const filtered = kinds.length > 0 || actor !== 'all' || query.length > 0

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
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
          {actors.map((a) => <option key={a} value={a}>{a}</option>)}
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
          <button
            type="button"
            className="btn ws-filter-x"
            onClick={() => { setKinds([]); setActor('all'); setQuery('') }}
          >
            Clear
          </button>
        ) : null}
      </div>

      <Panel>
        <div className="ws-sum">
          <span><b>{list.length}</b> of {AUDIT.length} changes</span>
          <span className="sep" />
          <span><b>{new Set(list.map((a) => a.who)).size}</b> people</span>
          <span className="sep" />
          <span>Retained for <b>2 years</b></span>
        </div>
        {!r1 ? <SkelRows n={6} icon={false} /> : list.length === 0 ? (
          <Empty title="Nothing matches" body="Try a wider filter — activity is only recorded for changes, not for reads." />
        ) : (
          <Fade>
            <div className="ws-rows">
              {days.map((day) => (
                <Fragment key={day}>
                  <div className="ws-day">{day}</div>
                  {list.filter((a) => a.day === day).map((a) => {
                    const isOpen = open === a.id
                    return (
                      <div className="ws-row" key={a.id} style={{ alignItems: 'flex-start' }}>
                        <span className="avatar">{a.initials}</span>
                        <div className="ws-row-main">
                          <b style={{ fontWeight: 400 }}>{a.what}</b>
                          <p>{a.who} · {a.when}</p>
                          {isOpen ? (
                            <>
                              <div className="ws-ba">
                                {a.changes.map((c) => (
                                  <div className="ws-ba-r" key={c.k}>
                                    <span className="k">{c.k}</span>
                                    <span className="from">{c.from}</span>
                                    <ArrowRight size={12} />
                                    <span className="to">{c.to}</span>
                                  </div>
                                ))}
                              </div>
                              {a.note ? (
                                <div className="ws-why" style={{ marginTop: 10 }}>
                                  <Info size={14} /><div>{a.note}</div>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                          <div style={{ marginTop: 9 }}>
                            <button type="button" className="ws-more" data-open={isOpen} onClick={() => setOpen(isOpen ? null : a.id)}>
                              <ChevronRight size={13} />{isOpen ? 'Hide' : 'What changed'}
                            </button>
                          </div>
                        </div>
                        <span className="ws-tag">{KIND_LABEL[a.kind]}</span>
                      </div>
                    )
                  })}
                </Fragment>
              ))}
            </div>
          </Fade>
        )}
        <div className="ws-panel-foot">
          The audit table exists and is written to on every permission change — nothing in the current admin reads it.
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
  const [r1, r2] = useStaged([280, 560], replay)
  const [tab, setTab] = useState<'runs' | 'failures' | 'cost'>('runs')
  const [channels, setChannels] = useState<CoRun['channel'][]>([])
  const [statuses, setStatuses] = useState<CoRun['status'][]>([])
  const [dept, setDept] = useState('all')
  const [query, setQuery] = useState('')

  const list = CO_RUNS.filter((r) => {
    if (channels.length && !channels.includes(r.channel)) return false
    if (statuses.length && !statuses.includes(r.status)) return false
    if (dept !== 'all' && r.dept !== dept) return false
    if (query && !`${r.summary} ${r.who}`.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const failures = useMemo(() => {
    const out = new Map<string, CoRun[]>()
    for (const r of CO_RUNS) {
      if (!r.fail) continue
      out.set(r.fail, [...(out.get(r.fail) ?? []), r])
    }
    return Array.from(out.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [])

  const totalModel = sum(MODEL_SPEND.map((m) => m.cost))
  const filtered = channels.length > 0 || statuses.length > 0 || dept !== 'all' || query.length > 0
  const countBy = (pick: (r: CoRun) => string, v: string) => CO_RUNS.filter((r) => pick(r) === v).length

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="AI Ops"
        description="Every task Divo has run for anyone, and what each one cost. Cost is priced from real token counts, not estimated."
      />
      <div className="filters">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'runs', label: 'Runs' },
            { value: 'failures', label: `Failures · ${CO_RUNS.filter((r) => r.fail).length}` },
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
            <select className="select" value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="all">Every department</option>
              {DEPARTMENTS.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
            {(['lark', 'desktop'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className="ws-chip"
                data-on={channels.includes(c)}
                onClick={() => setChannels((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))}
              >
                {c === 'lark' ? 'Lark' : 'Desktop'}<span className="n">{countBy((r) => r.channel, c)}</span>
              </button>
            ))}
            {(['completed', 'running', 'failed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className="ws-chip"
                data-on={statuses.includes(s)}
                onClick={() => setStatuses((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}
              >
                <span
                  className="ws-chip-dot"
                  style={{ background: s === 'failed' ? 'var(--cur-error)' : s === 'running' ? 'var(--cur-primary)' : 'var(--cur-success)' }}
                />
                {s === 'completed' ? 'Done' : s === 'running' ? 'Running' : 'Failed'}
                <span className="n">{countBy((r) => r.status, s)}</span>
              </button>
            ))}
            {filtered ? (
              <button
                type="button"
                className="btn ws-filter-x"
                onClick={() => { setChannels([]); setStatuses([]); setDept('all'); setQuery('') }}
              >
                Clear
              </button>
            ) : null}
          </div>

          <Panel>
            <div className="ws-sum">
              <span><b>{list.length}</b> runs</span>
              <span className="sep" />
              <span><b>{money(sum(list.map((r) => r.cost)))}</b> spent</span>
              <span className="sep" />
              <span><b>{list.filter((r) => r.status === 'failed').length}</b> failed</span>
              <span className="sep" />
              <span><b>{list.filter((r) => r.status === 'running').length}</b> still open</span>
            </div>
            {!r1 ? <SkelRows n={6} /> : list.length === 0 ? (
              <Empty title="No runs match" body="Widen the filter, or the window — this view only covers the last 48 hours." />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {Array.from(new Set(list.map((r) => r.day))).map((day) => (
                    <Fragment key={day}>
                      <div className="ws-day">{day}</div>
                      {list.filter((r) => r.day === day).map((r) => (
                        <div className="ws-row click" key={r.id} onClick={() => go('co-run')}>
                          <span className="avatar">{r.initials}</span>
                          <div className="ws-row-main">
                            <b>
                              {r.summary}
                              {r.status === 'running' && r.channel === 'lark' ? (
                                <span className="ws-note" title="The LLM proxy creates Lark runs and never closes them, so status and duration are unreliable for this channel.">
                                  status unknown
                                </span>
                              ) : null}
                            </b>
                            <p>
                              {r.who} · {r.dept} · {r.when} · {r.channel === 'lark' ? 'Lark' : 'Desktop'}{r.dur ? ` · ${r.dur}` : ''}
                              {r.fail ? ` · ${r.fail}` : ''}
                            </p>
                          </div>
                          <div className="ws-row-act">
                            <span className="ws-sub">{money(r.cost)}</span>
                            {r.status === 'failed' ? <span className="badge b-err"><span className="dot" />Failed</span> : null}
                            {r.status === 'completed' ? <span className="badge b-ok"><span className="dot" />Done</span> : null}
                            {r.status === 'running' ? <span className="badge b-run"><span className="dot" />Running</span> : null}
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
        <Panel
          title="Why runs failed"
          description="Grouped by cause, because the same cause keeps hitting different people"
        >
          {!r1 ? <SkelRows n={4} icon={false} /> : (
            <Fade>
              <div className="ws-rows">
                {failures.map(([reason, runs]) => (
                  <div className="ws-row" key={reason} style={{ alignItems: 'flex-start' }}>
                    <span className="ws-ic" data-tone="err"><TriangleAlert size={14} /></span>
                    <div className="ws-row-main">
                      <b>{reason}<span className="ws-tag">{runs.length} {runs.length === 1 ? 'run' : 'runs'}</span></b>
                      <p>{FAIL_FIX[reason]}</p>
                      <div className="ws-attn-meta">
                        <span>{Array.from(new Set(runs.map((r) => r.who))).join(', ')}</span>
                        <span>Most recent {runs[0].when.toLowerCase()}</span>
                      </div>
                      <div style={{ marginTop: 11, display: 'flex', gap: 8 }}>
                        <button type="button" className="btn" onClick={() => go('co-run')}>Open a run</button>
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
              {!r2 ? <SkelRows n={3} icon={false} /> : (
                <Fade>
                  {MODEL_SPEND.map((m) => (
                    <div key={m.model} style={{ marginBottom: 18 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{m.label} <span className="ws-sub">{m.model}</span></span>
                        <span className="ws-sub">{m.calls} calls · {money(m.cost)}</span>
                      </div>
                      <Bar pct={(m.cost / totalModel) * 100} tone={m.cost > 100 ? 'brand' : undefined} />
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
                    {DEPARTMENTS.map((d) => (
                      <div key={d.id} style={{ marginBottom: 16 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 12 }}>
                          <span>{d.name} <span className="ws-sub">{d.people} people</span></span>
                          <span className="ws-sub">{money(d.spend)}</span>
                        </div>
                        <Bar pct={(d.spend / sum(DEPARTMENTS.map((x) => x.spend))) * 100} />
                      </div>
                    ))}
                  </Fade>
                )}
              </div>
            </Panel>

            <Panel title="By channel">
              {!r2 ? <div className="ws-panel-body"><Skel w="100%" h={72} /></div> : (
                <Fade>
                  <div className="ws-metrics" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div className="ws-metric">
                      <div className="k">Desktop</div>
                      <div className="v">{money(47.02)}</div>
                      <div className="s">Longer tasks, higher cost each</div>
                    </div>
                    <div className="ws-metric">
                      <div className="k">Lark</div>
                      <div className="v">{money(11.44)}</div>
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
  const [r1] = useStaged([300], replay)
  const [blocked, setBlocked] = useState<string[]>([])

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Guardrails"
        description="Provider keys, and what each person is allowed to spend. This is the only limit that actually stops work."
      />
      <div className="ws-stack">
        <Panel title="Provider keys" description="Held encrypted by the backend, never returned to any client">
          {!r1 ? <SkelRows n={3} /> : (
            <Fade>
              <div className="ws-rows">
                {[
                  { p: 'DeepSeek', state: 'Active', last4: '··7f21', scope: 'Platform' },
                  { p: 'OpenAI', state: 'Active', last4: '··9c04', scope: 'Company' },
                  { p: 'Anthropic', state: 'No key', last4: '—', scope: '—' },
                ].map((k) => (
                  <div className="ws-row" key={k.p}>
                    <span className="ws-ic" data-tone={k.state === 'Active' ? 'ok' : undefined}><KeyRound size={14} /></span>
                    <div className="ws-row-main">
                      <b>{k.p}</b>
                      <p>{k.state === 'Active' ? `${k.scope} key · ${k.last4}` : 'Not configured'}</p>
                    </div>
                    <button type="button" className="btn" onClick={() => toast(`Manage ${k.p} key`)}>
                      {k.state === 'Active' ? 'Replace' : 'Add key'}
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

        <Panel title="Per-person limits" description="A monthly budget in dollars, enforced — the proxy returns 402 when it is reached">
          {!r1 ? <SkelRows n={4} /> : (
            <Fade>
              <div className="ws-rows">
                {PEOPLE.slice(0, 4).map((p) => {
                  const isBlocked = blocked.includes(p.id)
                  const budget = 40
                  return (
                    <div className="ws-row" key={p.id}>
                      <span className="avatar">{p.initials}</span>
                      <div className="ws-row-main">
                        <b>{p.name}</b>
                        <p>{money(p.spend30d)} of {money(budget)} this month</p>
                        <div style={{ marginTop: 8, maxWidth: 260 }}>
                          <Bar pct={(p.spend30d / budget) * 100} tone={p.spend30d / budget > 0.8 ? 'brand' : undefined} />
                        </div>
                      </div>
                      <div className="ws-row-act">
                        <span className="ws-sub">{isBlocked ? 'Blocked' : 'Allowed'}</span>
                        <Switch
                          on={!isBlocked}
                          label={`Allow ${p.name}`}
                          onToggle={() => {
                            setBlocked((b) => (b.includes(p.id) ? b.filter((x) => x !== p.id) : [...b, p.id]))
                            toast(isBlocked ? `${p.name.split(' ')[0]} unblocked` : `${p.name.split(' ')[0]} blocked`)
                          }}
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
            There is a second "token limit" in the old admin that nothing enforces — it should not be carried over
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
