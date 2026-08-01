/**
 * Company-scope drill-ins.
 *
 * The list screens answer "what is happening". These answer "what happened,
 * exactly" — and they are where the admin surface earns its keep. Divo already
 * records enough to reconstruct a run turn by turn; nothing else in the product
 * shows it.
 *
 * Trace styling deliberately reuses the `.turn` / `.step` / `.raw` / `.gate`
 * primitives already in cursor.css, which the existing RunDetailPage uses — so
 * porting that page to this layout is a re-skin, not a rewrite.
 */
import { useState } from 'react'
import {
  ArrowLeft, Ban, Brain, Building2, Check, ChevronDown, CircleAlert, Clock, Coins,
  KeyRound, Link2, Lock, Search, ShieldCheck, Sparkles, TriangleAlert, Users, Wrench,
} from 'lucide-react'
import {
  MY_USAGE, PEOPLE, ROLE_GRANTS, SKILLS, TOOLS, resolveGrants, toolById, type Person,
} from './fixtures'
import {
  Bar, DataNote, Empty, Fade, Matrix, PageHeader, Panel, Seg, Skel, SkelRows, Spark,
  Switch, compact, money, useStaged,
} from './ui'

type Props = { replay: number; toast: (m: string) => void; go: (s: string) => void }

/* ══════════════════════════════════════════════════════
   Run detail — the trace
   ══════════════════════════════════════════════════════ */

type Step = {
  tool: string
  stage: 'thinking' | 'grep' | 'read' | 'edit' | 'done'
  subtitle: string
  ms: number
  ok: boolean
  raw?: { input: string; output: string }
}

type Turn = {
  n: number
  model: string
  input: number
  output: number
  cacheRead: number
  costUsd: number
  steps: Step[]
}

const TURNS: Turn[] = [
  {
    n: 1, model: 'deepseek-v4-pro', input: 18_400, output: 1_210, cacheRead: 14_900, costUsd: 0.0642,
    steps: [
      { tool: 'zohoBooks', stage: 'read', subtitle: 'list_invoices · status=unpaid', ms: 1840, ok: true,
        raw: { input: '{ "op": "list_invoices", "status": "unpaid", "limit": 200 }', output: '{ "count": 47, "totalOutstanding": 2148000, "currency": "INR" }' } },
      { tool: 'zohoBooks', stage: 'read', subtitle: 'get_contacts · 47 suppliers', ms: 920, ok: true },
    ],
  },
  {
    n: 2, model: 'deepseek-v4-pro', input: 24_100, output: 3_480, cacheRead: 21_600, costUsd: 0.1287,
    steps: [
      { tool: 'googleSheets', stage: 'read', subtitle: 'read_range · Aged debt!A1:H200', ms: 1210, ok: true },
      { tool: 'memoryRecall', stage: 'thinking', subtitle: 'recall · supplier preferences', ms: 180, ok: true,
        raw: { input: '{ "query": "supplier contact preferences" }', output: '{ "hits": 2, "items": ["Vendor reminders should cc finance@acme.co", "Never contact Sharma Textiles directly"] }' } },
      { tool: 'googleGmail', stage: 'edit', subtitle: 'create_draft · 14 drafts', ms: 4310, ok: true },
    ],
  },
  {
    n: 3, model: 'deepseek-v4-flash', input: 6_200, output: 640, cacheRead: 5_800, costUsd: 0.0021,
    steps: [
      { tool: 'googleGmail', stage: 'done', subtitle: 'send · blocked, waiting on approval', ms: 40, ok: false },
    ],
  },
]

export function CompanyRunDetail({ replay, toast, go }: Props) {
  const [r1, r2] = useStaged([240, 520], replay)
  const [open, setOpen] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(true)

  const totalCost = TURNS.reduce((n, t) => n + t.costUsd, 0)
  const totalIn = TURNS.reduce((n, t) => n + t.input, 0)
  const totalOut = TURNS.reduce((n, t) => n + t.output, 0)
  const totalCache = TURNS.reduce((n, t) => n + t.cacheRead, 0)
  const steps = TURNS.reduce((n, t) => n + t.steps.length, 0)

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-aiops')}>
          <ArrowLeft size={13} />AI Ops
        </button>
      </div>

      <PageHeader
        eyebrow="Run"
        title="Drafted 14 supplier reminders"
        description="Asked by Ananya Mehta in a Lark chat · 2 hours ago"
        actions={
          <button type="button" className="btn" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? <Lock size={14} /> : <Search size={14} />}
            {showRaw ? 'Hide raw' : 'Show raw'}
          </button>
        }
      />

      {!r1 ? <Skel w="100%" h={26} /> : (
        <Fade>
          <div className="runmeta">
            <span>Status <b>Completed</b></span>
            <span>Duration <b>3m 41s</b></span>
            <span>Turns <b>{TURNS.length}</b></span>
            <span>Steps <b>{steps}</b></span>
            <span>Tokens <b>{compact(totalIn + totalOut)}</b></span>
            <span>Cache <b>{Math.round((totalCache / totalIn) * 100)}%</b></span>
            <span>Cost <b style={{ color: 'var(--cur-primary)' }}>{money(totalCost)}</b></span>
          </div>
        </Fade>
      )}

      <div className="ws-stack">
        <Panel title="Where the money went" description="Cost per turn, in order">
          <div className="ws-panel-body">
            {!r1 ? <Skel w="100%" h={40} /> : (
              <Fade>
                <div className="costbar">
                  {TURNS.map((t, i) => (
                    <span
                      key={t.n}
                      title={`Turn ${t.n} — ${money(t.costUsd)}`}
                      style={{
                        width: `${(t.costUsd / totalCost) * 100}%`,
                        background: i === 0 ? 'var(--cur-primary)' : i === 1 ? 'color-mix(in srgb, var(--cur-primary) 55%, transparent)' : 'var(--cur-surface-strong)',
                      }}
                    />
                  ))}
                </div>
                <div className="ws-legend" style={{ marginTop: 12 }}>
                  {TURNS.map((t) => (
                    <span key={t.n}>Turn {t.n} · {t.model.replace('deepseek-v4-', '')} · {money(t.costUsd)}</span>
                  ))}
                </div>
                <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.5 }}>
                  Turn 2 cost twice turn 1 because it read a 200-row sheet into context. {Math.round((totalCache / totalIn) * 100)}% of
                  input was served from cache, which is roughly 50× cheaper than a fresh read.
                </p>
              </Fade>
            )}
          </div>
        </Panel>

        <Panel title="What Divo actually did">
          <div className="ws-panel-body">
            {!r2 ? <SkelRows n={5} icon={false} /> : (
              <Fade>
                {TURNS.map((turn) => (
                  <div className="turn" key={turn.n}>
                    <div className="turn-h">
                      Turn {turn.n}
                      <span className="ln" />
                      <span>{turn.model}</span>
                      <span>{compact(turn.input)} in · {compact(turn.output)} out</span>
                      <span style={{ color: 'var(--cur-primary)' }}>{money(turn.costUsd)}</span>
                    </div>

                    {turn.steps.map((step, i) => {
                      const id = `${turn.n}-${i}`
                      const isOpen = open === id
                      const tool = toolById(step.tool)
                      return (
                        <div className="step" key={id}>
                          <span className={`tl tl-${step.stage}`} style={{ height: 20, alignSelf: 'flex-start' }}>
                            {step.stage}
                          </span>
                          <div className="main">
                            <div className="title">
                              <span className="name">{tool?.name ?? step.tool}</span>
                              <span className="muted" style={{ fontSize: 12.5 }}>{step.subtitle}</span>
                              {!step.ok ? <span className="badge b-err"><span className="dot" />Blocked</span> : null}
                            </div>
                            <div className="meta">
                              <span>Took <b>{step.ms < 1000 ? `${step.ms}ms` : `${(step.ms / 1000).toFixed(1)}s`}</b></span>
                              {step.raw ? (
                                <button
                                  type="button"
                                  className={`expand${isOpen ? ' open' : ''}`}
                                  style={{ border: 0, background: 'none', padding: 0 }}
                                  onClick={() => setOpen(isOpen ? null : id)}
                                >
                                  {isOpen ? 'Hide' : 'Show'} raw <ChevronDown size={12} />
                                </button>
                              ) : null}
                            </div>

                            {isOpen && step.raw ? (
                              showRaw ? (
                                <div className="raw">
                                  <div className="lbl">Input</div>
                                  <pre>{step.raw.input}</pre>
                                  <div className="lbl">Output</div>
                                  <pre>{step.raw.output}</pre>
                                </div>
                              ) : (
                                <div className="gate">
                                  <Lock size={13} />
                                  Raw input and output are hidden. The backend redacts these unless your session
                                  carries <b>canViewRawExecutionData</b>.
                                </div>
                              )
                            ) : null}

                            {!step.ok ? (
                              <div className="gate">
                                <ShieldCheck size={13} />
                                Divo stopped here and asked Arjun Shah to approve sending. It did not send anything.
                              </div>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </Fade>
            )}
          </div>
          <div className="ws-panel-foot">
            <CircleAlert size={13} />
            Step detail is kept for 7 days. Cost and token history is kept indefinitely.
          </div>
        </Panel>
      </div>
    </>
  )
}

/* ══════════════════════════════════════════════════════
   Person detail
   ══════════════════════════════════════════════════════ */

const DENIALS = [
  { when: '2 days ago', model: 'deepseek-v4-pro', reason: 'Monthly budget reached', status: 402 },
  { when: '2 days ago', model: 'deepseek-v4-pro', reason: 'Monthly budget reached', status: 402 },
]

export function CompanyPersonDetail({ personId = 'u_ananya', replay, toast, go }: Props & { personId?: string }) {
  const [r1, r2] = useStaged([260, 560], replay)
  const person = PEOPLE.find((p) => p.id === personId) ?? PEOPLE[0]
  const [tab, setTab] = useState<'activity' | 'access' | 'limits'>('activity')
  const budget = 40

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-people')}>
          <ArrowLeft size={13} />Everyone
        </button>
      </div>

      {!r1 ? <Skel w={300} h={56} /> : (
        <Fade>
          <div className="profile">
            <div className="pic">{person.initials}</div>
            <div style={{ flex: 1 }}>
              <h1>{person.name}</h1>
              <div className="sub">
                <span>{person.email}</span>
                <span>·</span>
                <span>{person.title}</span>
                <span>·</span>
                <span>{person.deptRoleName} in Finance</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={() => toast('Message in Lark')}>Message</button>
              <button type="button" className="btn" onClick={() => go('co-people')}>Change role</button>
            </div>
          </div>
        </Fade>
      )}

      <div className="filters">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'activity', label: 'Activity' },
            { value: 'access', label: 'Access' },
            { value: 'limits', label: 'Limits' },
          ]}
        />
      </div>

      {tab === 'activity' ? (
        <div className="ws-stack">
          <div className="ws-cols">
            <Panel title="Last 30 days">
              <div className="ws-panel-body">
                {!r2 ? <Skel w="100%" h={110} /> : (
                  <Fade>
                    <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap' }}>
                      <div>
                        <div className="ws-lbl">Cost</div>
                        <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(person.spend30d)}</div>
                      </div>
                      <div>
                        <div className="ws-lbl">Tasks</div>
                        <div className="ws-num" style={{ marginTop: 8 }}>{person.runs30d}</div>
                      </div>
                      <div>
                        <div className="ws-lbl">Avg per task</div>
                        <div className="ws-num" style={{ marginTop: 8 }}>
                          {person.runs30d ? money(person.spend30d / person.runs30d) : '—'}
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: 22 }}><Spark data={MY_USAGE.daily} /></div>
                  </Fade>
                )}
              </div>
            </Panel>

            <Panel title="Connections" description="What they have linked">
              {!r2 ? <SkelRows n={3} /> : (
                <Fade>
                  <div className="ws-rows">
                    {person.connections.length === 0 ? (
                      <div style={{ padding: 18 }}>
                        <Empty icon={Link2} title="Nothing connected" body="Divo cannot act on their behalf anywhere yet." />
                      </div>
                    ) : person.connections.map((c) => (
                      <div className="ws-row click" key={c} onClick={() => toast('Connection governance')}>
                        <span className="ws-ic"><Link2 size={14} /></span>
                        <div className="ws-row-main">
                          <b>{c === 'google_workspace' ? 'Google Workspace' : c === 'lark' ? 'Lark' : c === 'zoho' ? 'Zoho (company)' : 'Airtable'}</b>
                          <p>{c === 'zoho' ? 'Shared with them' : 'Their own account'}</p>
                        </div>
                        <span className="badge b-ok"><span className="dot" />On</span>
                      </div>
                    ))}
                  </div>
                </Fade>
              )}
              <div className="ws-panel-foot">
                <ShieldCheck size={13} />
                You can see that a connection exists and set policy — never its tokens or contents
              </div>
            </Panel>
          </div>

          <Panel title="Recent runs" source="myRuns">
            {!r2 ? <SkelRows n={4} icon={false} /> : (
              <Fade>
                <div className="ws-rows">
                  {[
                    { s: 'Drafted 14 supplier reminders', w: '2 hours ago', c: 0.38, st: 'completed' },
                    { s: 'Reconciled the March vendor ledger', w: 'Yesterday', c: 0.21, st: 'running' },
                    { s: 'Built the Q2 expense breakdown', w: '2 days ago', c: 0.71, st: 'completed' },
                    { s: 'Looked up supplier GST numbers', w: '3 days ago', c: 0.02, st: 'failed' },
                  ].map((r) => (
                    <div className="ws-row click" key={r.s} onClick={() => go('co-run')}>
                      <div className="ws-row-main">
                        <b>{r.s}</b>
                        <p>{r.w}</p>
                      </div>
                      <div className="ws-row-act">
                        <span className="ws-sub">{money(r.c)}</span>
                        {r.st === 'failed' ? <span className="badge b-err"><span className="dot" />Failed</span> : null}
                        {r.st === 'completed' ? <span className="badge b-ok"><span className="dot" />Done</span> : null}
                        {r.st === 'running' ? <span className="badge b-run"><span className="dot" />Running</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </Panel>
        </div>
      ) : null}

      {tab === 'access' ? (
        <Panel title="What Divo can do for them" description={`From the ${person.deptRoleName} role in Finance, plus anything granted personally`} source="permissions">
          <div className="ws-panel-body">
            {!r2 ? <SkelRows n={6} icon={false} /> : (
              <Fade><Matrix grants={resolveGrants(person)} readOnly tools={TOOLS.filter((t) => !t.adminOnly)} /></Fade>
            )}
          </div>
          <div className="ws-panel-foot">
            Change these from the department, not here — a company admin editing one person is how drift starts
          </div>
        </Panel>
      ) : null}

      {tab === 'limits' ? (
        <div className="ws-stack">
          <Panel title="Spending" description="Enforced — the proxy returns 402 when the budget is reached">
            <div className="ws-panel-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="ws-num-sm">{money(person.spend30d)}</span>
                <span className="ws-sub">of {money(budget)} this month</span>
              </div>
              <div style={{ marginTop: 12 }}><Bar pct={(person.spend30d / budget) * 100} tone="brand" /></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 22 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>Allow Divo to work for them</div>
                  <div className="ws-sub" style={{ marginTop: 3 }}>Blocking is immediate and applies to every channel</div>
                </div>
                <Switch on onToggle={() => toast('Blocked')} label="Allow" />
              </div>
            </div>
          </Panel>

          <Panel title="Models they may use">
            <div className="ws-rows">
              {[
                { id: 'flash', name: 'Flash', on: true },
                { id: 'pro', name: 'Pro', on: true },
                { id: 'luna', name: 'Luna', on: false },
              ].map((m) => (
                <div className="ws-row" key={m.id}>
                  <div className="ws-row-main"><b>{m.name}</b></div>
                  <Switch on={m.on} onToggle={() => toast(`${m.name} toggled`)} label={m.name} />
                </div>
              ))}
            </div>
            <div className="ws-panel-foot">
              An empty list means every model is allowed — the picker hides itself when only one is
            </div>
          </Panel>

          <Panel title="Recent refusals" description="Requests the proxy turned away">
            {DENIALS.length === 0 ? (
              <Empty icon={Check} title="Nothing refused" />
            ) : (
              <div className="ws-rows">
                {DENIALS.map((d, i) => (
                  <div className="ws-row" key={i}>
                    <span className="ws-ic" data-tone="err"><Ban size={14} /></span>
                    <div className="ws-row-main">
                      <b style={{ fontWeight: 400 }}>{d.reason}</b>
                      <p>{d.when} · {d.model} · HTTP {d.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      ) : null}
    </>
  )
}

/* ══════════════════════════════════════════════════════
   Department detail
   ══════════════════════════════════════════════════════ */

export function CompanyDepartmentDetail({ replay, toast, go }: Props) {
  const [r1] = useStaged([280], replay)
  const [tab, setTab] = useState<'people' | 'roles' | 'access' | 'config'>('people')
  const members = PEOPLE

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-departments')}>
          <ArrowLeft size={13} />Departments
        </button>
      </div>

      <PageHeader
        eyebrow="Department"
        title="Finance"
        description="Six people, three roles, led by Arjun Shah. Managers govern their own department — this view is for when you need to reach in."
        actions={<button type="button" className="btn" onClick={() => toast('Archive department')}>Archive</button>}
      />

      <div className="filters">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'people', label: `People (${members.length})` },
            { value: 'roles', label: 'Roles (3)' },
            { value: 'access', label: 'Access' },
            { value: 'config', label: 'Persona' },
          ]}
        />
      </div>

      {tab === 'people' ? (
        <Panel source="teamPeople">
          {!r1 ? <SkelRows n={6} /> : (
            <Fade>
              <div className="ws-rows">
                {members.map((p) => (
                  <div className="ws-row click" key={p.id} onClick={() => go('co-person')}>
                    <span className="avatar">{p.initials}</span>
                    <div className="ws-row-main">
                      <b>{p.name}{p.deptRole === 'MANAGER' ? <span className="ws-tag">Manager</span> : null}</b>
                      <p>{p.title} · {p.deptRoleName}</p>
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
      ) : null}

      {tab === 'roles' ? (
        <Panel title="Roles in Finance" description="Manager and Member are system roles and cannot be renamed or deleted">
          <div className="ws-rows">
            {[
              { name: 'Manager', slug: 'MANAGER', system: true, holders: 1 },
              { name: 'Analyst', slug: 'ANALYST', system: false, holders: 2 },
              { name: 'Member', slug: 'MEMBER', system: true, holders: 3 },
            ].map((r) => (
              <div className="ws-row" key={r.slug}>
                <span className="ws-ic"><Users size={14} /></span>
                <div className="ws-row-main">
                  <b>{r.name}{r.system ? <span className="ws-tag"><Lock size={10} />System</span> : null}</b>
                  <p>{r.holders} {r.holders === 1 ? 'person' : 'people'} · slug {r.slug}</p>
                </div>
                {!r.system ? <button type="button" className="btn" onClick={() => toast('Rename')}>Rename</button> : null}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {tab === 'access' ? (
        <div className="ws-stack">
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div>
              This is the same matrix the department's manager sees. Editing here <b>silently overrides them</b> —
              prefer asking the manager unless they are unreachable.
            </div>
          </div>
          <Panel title="Member role" source="permissions">
            <div className="ws-panel-body">
              {!r1 ? <SkelRows n={6} icon={false} /> : (
                <Fade><Matrix grants={ROLE_GRANTS.MEMBER} readOnly tools={TOOLS.filter((t) => !t.adminOnly)} /></Fade>
              )}
            </div>
          </Panel>
        </div>
      ) : null}

      {tab === 'config' ? (
        <div className="ws-stack">
          <Panel title="How Divo behaves for this department" description="Prepended to every run for anyone in Finance">
            <div className="ws-panel-body">
              <textarea
                className="input"
                style={{ width: '100%', height: 130, padding: 12, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.55 }}
                defaultValue={'Figures in lakhs unless asked otherwise. The quarter closes on the 5th, not the last working day. Always cc finance@acme.co on anything going to a supplier.'}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="btn primary" onClick={() => toast('Persona saved')}>Save</button>
              </div>
            </div>
            <div className="ws-panel-foot">
              <Brain size={13} />
              This is context, never authority — it cannot grant a permission the role does not have
            </div>
          </Panel>
        </div>
      ) : null}
    </>
  )
}

/* ══════════════════════════════════════════════════════
   Skill detail
   ══════════════════════════════════════════════════════ */

export function CompanySkillDetail({ replay, toast, go }: Props) {
  const [r1] = useStaged([260], replay)
  const skill = SKILLS[0]

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-skills')}>
          <ArrowLeft size={13} />Skills
        </button>
      </div>

      <PageHeader
        eyebrow="Skill"
        title={skill.name}
        description={skill.blurb}
        actions={<button type="button" className="btn" onClick={() => toast('Archive skill')}>Archive</button>}
      />

      <div className="ws-cols">
        <div className="ws-stack">
          <Panel title="What it needs" description="A skill stays invisible unless the person holds every tool it uses">
            <div className="ws-rows">
              {skill.tools.map((t) => {
                const tool = toolById(t)
                return (
                  <div className="ws-row" key={t}>
                    <span className="ws-ic" data-tone="ok"><Wrench size={14} /></span>
                    <div className="ws-row-main">
                      <b>{tool?.name}</b>
                      <p>{tool?.family}</p>
                    </div>
                    <span className="badge b-ok"><span className="dot" />Granted</span>
                  </div>
                )
              })}
            </div>
            <div className="ws-panel-foot">
              <CircleAlert size={13} />
              Divo hides a skill it cannot complete rather than starting it and failing halfway
            </div>
          </Panel>

          <Panel title="Who can run it" description="Deny by default — access is an explicit grant">
            {!r1 ? <SkelRows n={3} /> : (
              <Fade>
                <div className="ws-rows">
                  {[
                    { icon: Building2, label: 'Finance', detail: 'Department · 6 people' },
                    { icon: Users, label: 'Analyst', detail: 'Role · 2 people' },
                    { icon: Users, label: 'Kabir Shah', detail: 'Person' },
                  ].map((g) => (
                    <div className="ws-row" key={g.label}>
                      <span className="ws-ic"><g.icon size={14} /></span>
                      <div className="ws-row-main"><b>{g.label}</b><p>{g.detail}</p></div>
                      <button type="button" className="btn" onClick={() => toast('Access removed')}>Remove</button>
                    </div>
                  ))}
                </div>
              </Fade>
            )}
            <div className="ws-panel-foot">
              <button type="button" className="btn" onClick={() => toast('Grant access')}>Grant access</button>
            </div>
          </Panel>
        </div>

        <div className="ws-stack">
          <Panel title="Usage">
            <div className="ws-panel-body">
              <div className="ws-lbl">Runs, 30 days</div>
              <div className="ws-num" style={{ marginTop: 8 }}>{skill.runs30d}</div>
              <div style={{ marginTop: 20 }}>
                <div className="kv"><span className="k">Owner</span><span className="v">{skill.owner}</span></div>
                <div className="kv"><span className="k">Scope</span><span className="v">{skill.scope}</span></div>
                <div className="kv"><span className="k">Updated</span><span className="v">{skill.updated}</span></div>
                <div className="kv"><span className="k">Revision</span><span className="v">4</span></div>
              </div>
            </div>
          </Panel>

          <Panel title="History">
            <div className="ws-panel-body">
              {[
                { v: 'Revision 4', d: '3 days ago — added the cc rule' },
                { v: 'Revision 3', d: '2 weeks ago — narrowed to unpaid only' },
                { v: 'Revision 2', d: '1 month ago — first shared version' },
              ].map((h, i) => (
                <div className="ws-ver" key={h.v}>
                  <div className="ws-ver-line">
                    <span className="ws-ver-dot" data-now={i === 0} />
                    {i < 2 ? <span className="ws-ver-rail" /> : null}
                  </div>
                  <div style={{ paddingBottom: i < 2 ? 12 : 0 }}>
                    <b>{h.v}</b>
                    <p>{h.d}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </>
  )
}
