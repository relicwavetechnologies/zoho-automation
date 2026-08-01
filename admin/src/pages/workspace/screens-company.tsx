/**
 * "Company" scope — the admin surface.
 *
 * Deliberately lighter than the team scope: most of this already exists in the
 * current admin app and works. What's new is that it now lives in the SAME
 * shell as the member and manager views, so an admin stops context-switching
 * between two products, and the company ceiling finally sits visibly above the
 * team grants that it silently clamps.
 */
import { useState } from 'react'
import {
  Brain, Building2, Check, KeyRound, Lock, Plus, Search, ShieldCheck, Sparkles, Trash2, TriangleAlert, Users,
} from 'lucide-react'
import {
  ACTION_GROUPS, COMPANY_CEILING, CONNECTORS, MEMORIES, PEOPLE, SKILLS, TEAM_USAGE, TOOLS, toolById,
  type ActionGroup,
} from './fixtures'
import {
  Bar, DataNote, Empty, Fade, PageHeader, Panel, ProviderMark, Seg, Skel, SkelRows,
  Switch, money, providerName, useStaged,
} from './ui'

type Props = { replay: number; toast: (m: string) => void; go: (screen: string) => void }

const DEPARTMENTS = [
  { id: 'd_finance', name: 'Finance', people: 6, manager: 'Arjun Shah', spend: 102.21, roles: 3 },
  { id: 'd_ops', name: 'Operations', people: 11, manager: 'Sana Qureshi', spend: 188.4, roles: 4 },
  { id: 'd_sales', name: 'Sales', people: 19, manager: 'Vikram Desai', spend: 341.07, roles: 2 },
  { id: 'd_people', name: 'People', people: 4, manager: null, spend: 22.8, roles: 2 },
]

const AUDIT = [
  { who: 'Arjun Shah', what: 'Gave Ananya Mehta permission to send mail', when: '12 minutes ago', kind: 'permission' },
  { who: 'Dev Kapoor', what: 'Raised the company ceiling on Airtable records', when: '2 hours ago', kind: 'ceiling' },
  { who: 'Rohan Iyer', what: 'Connected Airtable to his own account', when: 'Yesterday', kind: 'connection' },
  { who: 'Arjun Shah', what: 'Approved a write-off of 6 invoices', when: 'Yesterday', kind: 'approval' },
  { who: 'Sana Qureshi', what: 'Created the "Vendor ops" role in Operations', when: '3 days ago', kind: 'role' },
]

/* ══ Company overview ══════════════════════════════════ */
export function CompanyHome({ replay, go }: Props) {
  const [r1, r2] = useStaged([260, 560], replay)
  const noManager = DEPARTMENTS.filter((d) => !d.manager)
  const totalSpend = DEPARTMENTS.reduce((n, d) => n + d.spend, 0)

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Company"
        description="Forty-eight people across four departments. You set the ceiling every team works within."
      />
      <div className="ws-stack">
        <Panel title="Needs you">
          {!r1 ? <SkelRows n={2} icon={false} /> : (
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
                      <div className="ws-attn-meta"><span>{d.people} people affected</span></div>
                    </div>
                    <button type="button" className="btn" onClick={() => go('departments')}>Assign</button>
                  </div>
                ))}
                <div className="ws-attn-item" data-tone="act">
                  <span className="ws-attn-bar" />
                  <div className="ws-attn-main">
                    <b>Two access requests are waiting on a manager</b>
                    <p>Both have been outstanding for more than a day. Requests expire silently.</p>
                    <div className="ws-attn-meta"><span>Finance · Operations</span></div>
                  </div>
                  <button type="button" className="btn" onClick={() => go('people')}>Review</button>
                </div>
              </div>
            </Fade>
          )}
        </Panel>

        <div className="ws-cols">
          <Panel title="Departments" aside={<button type="button" className="btn" onClick={() => go('departments')}>Manage</button>}>
            {!r2 ? <SkelRows n={4} /> : (
              <Fade>
                <div className="ws-rows">
                  {DEPARTMENTS.map((d) => (
                    <div className="ws-row click" key={d.id} onClick={() => go('departments')}>
                      <span className="ws-ic"><Building2 size={14} /></span>
                      <div className="ws-row-main">
                        <b>{d.name}</b>
                        <p>{d.people} people · {d.manager ? `led by ${d.manager}` : 'no manager'} · {d.roles} roles</p>
                      </div>
                      <span className="ws-sub">{money(d.spend)}</span>
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </Panel>

          <Panel title="Spend">
            <div className="ws-panel-body">
              {!r2 ? <Skel w="100%" h={120} /> : (
                <Fade>
                  <div className="ws-lbl">Last 30 days</div>
                  <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(totalSpend)}</div>
                  <div style={{ marginTop: 20 }}>
                    {DEPARTMENTS.map((d) => (
                      <div key={d.id} style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                          <span>{d.name}</span><span className="ws-sub">{money(d.spend)}</span>
                        </div>
                        <Bar pct={(d.spend / totalSpend) * 100} />
                      </div>
                    ))}
                  </div>
                </Fade>
              )}
            </div>
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
export function CompanyPeople({ replay, toast, go }: Props) {
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

/* ══ Company connections ═══════════════════════════════ */
export function CompanyConnections({ replay, toast }: Props) {
  const [r1] = useStaged([300], replay)
  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Company connections"
        description="Accounts connected once for everyone. Personal connections stay private to whoever made them — you can see that one exists, never its contents."
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
                      <p>{c.blurb} · {c.auth}</p>
                    </div>
                    <span className="badge b-ok"><span className="dot" />On</span>
                  </div>
                ))}
                <div className="ws-row click" onClick={() => toast('Add a company connection')}>
                  <span className="ws-ic"><KeyRound size={14} /></span>
                  <div className="ws-row-main">
                    <b>Web search</b>
                    <p>Company API key · 41,200 credits remaining</p>
                  </div>
                  <span className="badge b-ok"><span className="dot" />On</span>
                </div>
              </div>
            </Fade>
          )}
        </Panel>

        <Panel title="Personal connections" description="What people connected themselves">
          {!r1 ? <SkelRows n={3} /> : (
            <Fade>
              <div className="ws-rows">
                {CONNECTORS.filter((c) => c.memberCanConnect).map((c) => (
                  <div className="ws-row" key={c.provider}>
                    <ProviderMark provider={c.provider} />
                    <div className="ws-row-main">
                      <b>{c.name}</b>
                      <p>{c.provider === 'google_workspace' ? '31 people' : c.provider === 'lark' ? '48 people' : '4 people'} connected their own account</p>
                    </div>
                    <span className="ws-sub">Private to each person</span>
                  </div>
                ))}
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

/* ══ Activity / audit ══════════════════════════════════ */
export function CompanyAudit({ replay }: Props) {
  const [r1] = useStaged([300], replay)
  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="Activity"
        description="Who changed what. Every permission grant, connection and approval decision is recorded."
      />
      <Panel>
        {!r1 ? <SkelRows n={5} icon={false} /> : (
          <Fade>
            <div className="ws-rows">
              {AUDIT.map((a, i) => (
                <div className="ws-row" key={i}>
                  <div className="ws-row-main">
                    <b style={{ fontWeight: 400 }}>{a.what}</b>
                    <p>{a.who} · {a.when}</p>
                  </div>
                  <span className="ws-tag">{a.kind}</span>
                </div>
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

   These four exist today as standalone admin pages wired to live endpoints.
   They are re-specified here inside the Company scope so the whole product
   lives in one shell. Data mapping comes later — the hooks in
   `admin/src/cursor/` are kept and will be plugged straight in.
   ══════════════════════════════════════════════════════ */

const RUNS = [
  { id: 'r1', who: 'Rohan Iyer', summary: 'Reconciled the March vendor ledger', channel: 'lark', status: 'running', when: '4 min ago', dur: null, cost: 0.21 },
  { id: 'r2', who: 'Ananya Mehta', summary: 'Drafted 14 supplier reminders', channel: 'desktop', status: 'completed', when: '2 hours ago', dur: '3m 41s', cost: 0.38 },
  { id: 'r3', who: 'Priya Nair', summary: 'Built the Q2 expense breakdown', channel: 'desktop', status: 'completed', when: '4 hours ago', dur: '6m 02s', cost: 0.71 },
  { id: 'r4', who: 'Sana Qureshi', summary: 'Chased three shipment delays', channel: 'lark', status: 'running', when: 'Yesterday', dur: null, cost: 0.14 },
  { id: 'r5', who: 'Kabir Shah', summary: 'Looked up supplier GST numbers', channel: 'desktop', status: 'failed', when: 'Yesterday', dur: '0m 22s', cost: 0.02 },
]

const MODEL_SPEND = [
  { model: 'deepseek-v4-flash', label: 'Flash', calls: 4820, cost: 34.11 },
  { model: 'deepseek-v4-pro', label: 'Pro', calls: 962, cost: 118.42 },
  { model: 'gpt-5.6-luna', label: 'Luna', calls: 114, cost: 21.55 },
]

/* ══ AI Ops ════════════════════════════════════════════ */
export function CompanyAiOps({ replay, toast, go }: Props) {
  const [r1, r2] = useStaged([280, 560], replay)
  const [tab, setTab] = useState<'runs' | 'cost'>('runs')
  const total = MODEL_SPEND.reduce((n, m) => n + m.cost, 0)

  return (
    <>
      <PageHeader
        eyebrow="Acme Technologies"
        title="AI Ops"
        description="Every task Divo has run for anyone, and what each one cost. Cost is priced from real token counts, not estimated."
      />
      <div className="filters">
        <Seg value={tab} onChange={setTab} options={[{ value: 'runs', label: 'Runs' }, { value: 'cost', label: 'Cost' }]} />
      </div>

      {tab === 'runs' ? (
        <Panel title="Recent runs">
          {!r1 ? <SkelRows n={5} icon={false} /> : (
            <Fade>
              <div className="ws-rows">
                {RUNS.map((r) => (
                  <div className="ws-row click" key={r.id} onClick={() => go('co-run')}>
                    <div className="ws-row-main">
                      <b>
                        {r.summary}
                        {r.status === 'running' && r.channel === 'lark' ? (
                          <span className="ws-note" title="The LLM proxy creates Lark runs and never closes them, so status and duration are unreliable for this channel.">
                            status unknown
                          </span>
                        ) : null}
                      </b>
                      <p>{r.who} · {r.when} · {r.channel === 'lark' ? 'Lark' : 'Desktop'}{r.dur ? ` · ${r.dur}` : ''}</p>
                    </div>
                    <div className="ws-row-act">
                      <span className="ws-sub">{money(r.cost)}</span>
                      {r.status === 'failed' ? <span className="badge b-err"><span className="dot" />Failed</span> : null}
                      {r.status === 'completed' ? <span className="badge b-ok"><span className="dot" />Done</span> : null}
                      {r.status === 'running' ? <span className="badge b-run"><span className="dot" />Running</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            <TriangleAlert size={13} />
            Lark runs are never terminated by the backend — do not build a completed-vs-failed chart that includes them
          </div>
        </Panel>
      ) : (
        <Panel title="Cost by model" description={`${money(total)} across the last 30 days`}>
          <div className="ws-panel-body">
            {!r2 ? <SkelRows n={3} icon={false} /> : (
              <Fade>
                {MODEL_SPEND.map((m) => (
                  <div key={m.model} style={{ marginBottom: 18 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{m.label} <span className="ws-sub">{m.model}</span></span>
                      <span className="ws-sub">{m.calls} calls · {money(m.cost)}</span>
                    </div>
                    <Bar pct={(m.cost / total) * 100} tone={m.cost > 100 ? 'brand' : undefined} />
                  </div>
                ))}
              </Fade>
            )}
          </div>
          <div className="ws-panel-foot">
            Priced from real cache-split token counts — not the blended estimate the old analytics KPIs used
          </div>
        </Panel>
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
