/**
 * Company-scope drill-ins.
 *
 * The list screens answer "what is happening". These answer "what happened,
 * exactly" — and they are where the admin surface earns its keep. Divo already
 * records enough to reconstruct a run turn by turn; nothing else in the product
 * shows it.
 *
 * Trace styling reuses the `.turn` / `.step` / `.raw` / `.gate` primitives
 * already in cursor.css, and the run trace reuses `reconstructRun` — turning a
 * flat event stream back into turns is the hard part, and it was already
 * right.
 */
import { useState } from 'react'
import { useParams } from 'react-router-dom'
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
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useRunDetail, type RunTurnView } from '@/cursor/use-run-detail'
import { useCompanyScope, useMemberSpend } from '@/cursor/use-spend'
import { useProxyPolicy, useSaveProxyPolicy, type ProxyPolicyInput } from '@/cursor/use-proxy-policy'
import { useProxyAudit, useProxyModels } from '@/cursor/use-proxy'
import { ROLE_LABEL, ago, displayName, initialsOf, useDirectory, useRuns } from './data/use-company'

/** Mirrors the run badge on the AI Ops list, so a status reads the same everywhere. */
const RunStatusBadge = ({ status }: { status: string }) => (
  <span className={status === 'failed' ? 'badge b-err' : status === 'running' ? 'badge b-run' : 'badge b-ok'}>
    <span className="dot" />{status === 'failed' ? 'Failed' : status === 'running' ? 'Running' : 'Done'}
  </span>
)

/** How a channel is named in prose, as opposed to in a filter chip. */
const CHANNEL_WORD: Record<string, string> = { lark: 'in a Lark chat', desktop: 'on the desktop', api: 'over the API' }

type Props = { replay: number; toast: (m: string) => void; go: (s: string) => void }

/* ══════════════════════════════════════════════════════
   Run detail — the trace
   ══════════════════════════════════════════════════════ */

/**
 * Reconstructing turns from a flat event stream is the hard part of this
 * screen, and `reconstructRun` already did it correctly for the old page. That
 * logic is kept verbatim; only the presentation changes — which is exactly what
 * this file's header predicted a port would be.
 *
 * What did change is honesty about the gate: raw tool input and output are
 * redacted by the backend unless the session carries `canViewRawExecutionData`,
 * so the toggle says which of those two things is happening rather than
 * pretending the button failed.
 */
export function CompanyRunDetail({ replay, go }: Props) {
  const { runId } = useParams()
  const { token, session } = useAdminAuth()
  const [r1, r2] = useStaged([240, 520], replay)
  const [open, setOpen] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(true)
  const { data: run, isLoading, isError } = useRunDetail(runId, token)

  // Only a company or super admin is served raw I/O; anyone else gets the
  // summary and a locked panel, matching what the backend will actually return.
  const maySeeRaw = session?.role === 'COMPANY_ADMIN' || session?.role === 'SUPER_ADMIN'

  if (isLoading) {
    return (
      <>
        <div className="crumbs">
          <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-aiops')}>
            <ArrowLeft size={13} />AI Ops
          </button>
        </div>
        <Skel w="100%" h={26} />
        <div style={{ marginTop: 20 }}><SkelRows n={5} icon={false} /></div>
      </>
    )
  }

  if (isError || !run) {
    return (
      <>
        <div className="crumbs">
          <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-aiops')}>
            <ArrowLeft size={13} />AI Ops
          </button>
        </div>
        <Empty
          icon={CircleAlert}
          title="This run cannot be shown"
          body="Either it does not belong to your company, or its trace has been pruned — step detail is kept for a week."
        />
      </>
    )
  }

  const steps = run.turns.reduce((n, t) => n + t.tools.length, 0)
  const turnCost = (turn: RunTurnView) => turn.model?.costUsd ?? 0
  const totalCost = run.totals.costUsd

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-aiops')}>
          <ArrowLeft size={13} />AI Ops
        </button>
      </div>

      <PageHeader
        eyebrow="Run"
        title={run.latestSummary ?? 'No summary recorded'}
        description={`Asked by ${run.userName ?? 'someone unattributed'} · ${CHANNEL_WORD[run.channel] ?? run.channel} · ${run.entrypoint}`}
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
            <span>Status <b>{run.statusLabel}</b></span>
            <span>Duration <b>{run.durationLabel}</b></span>
            <span>Turns <b>{run.totals.turns}</b></span>
            <span>Steps <b>{steps}</b></span>
            <span>Tokens <b>{compact(run.totals.tokens)}</b></span>
            <span>Cache <b>{run.cacheOfInputPct}%</b></span>
            <span>Cost <b style={{ color: 'var(--cur-primary)' }}>{money(totalCost)}</b></span>
          </div>
        </Fade>
      )}

      <div className="ws-stack">
        <Panel title="Where the money went" description="Cost per turn, in order">
          <div className="ws-panel-body">
            {!r1 ? <Skel w="100%" h={40} /> : totalCost === 0 ? (
              <p className="ws-sub" style={{ lineHeight: 1.5 }}>
                No token usage was attributed to this run. That is not the same as it being free — it means the
                model calls were recorded without a run id, which is normal on the Lark channel.
              </p>
            ) : (
              <Fade>
                <div className="costbar">
                  {run.turns.map((turn, i) => (
                    <span
                      key={i}
                      title={`Turn ${i + 1} — ${money(turnCost(turn))}`}
                      style={{
                        width: `${(turnCost(turn) / totalCost) * 100}%`,
                        background: i === 0
                          ? 'var(--cur-primary)'
                          : i % 2 === 1
                            ? 'color-mix(in srgb, var(--cur-primary) 55%, transparent)'
                            : 'var(--cur-surface-strong)',
                      }}
                    />
                  ))}
                </div>
                <div className="ws-legend" style={{ marginTop: 12 }}>
                  {run.turns.map((turn, i) => (
                    <span key={i}>Turn {i + 1}{turn.model ? ` · ${turn.model.modelName}` : ''} · {money(turnCost(turn))}</span>
                  ))}
                </div>
                <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.5 }}>
                  {run.cacheOfInputPct}% of input was served from cache, which is roughly 50× cheaper than a
                  fresh read. The turns that read most into context are the ones that cost.
                </p>
              </Fade>
            )}
          </div>
        </Panel>

        <Panel title="What Divo actually did">
          <div className="ws-panel-body">
            {!r2 ? <SkelRows n={5} icon={false} /> : run.turns.length === 0 ? (
              <Empty title="No trace for this run" body="Step detail is kept for 7 days; cost and token history is kept indefinitely." />
            ) : (
              <Fade>
                {run.turns.map((turn, ti) => (
                  <div className="turn" key={ti}>
                    <div className="turn-h">
                      Turn {ti + 1}
                      <span className="ln" />
                      {turn.model ? (
                        <>
                          <span>{turn.model.modelName}</span>
                          <span>{compact(turn.model.input)} in · {compact(turn.model.output)} out</span>
                          <span style={{ color: 'var(--cur-primary)' }}>{money(turn.model.costUsd)}</span>
                        </>
                      ) : (
                        <span className="ws-sub">no model call recorded</span>
                      )}
                    </div>

                    {turn.tools.map((step, i) => {
                      const id = `${ti}-${i}`
                      const isOpen = open === id
                      return (
                        <div className="step" key={id}>
                          <span className={`tl tl-${step.stage}`} style={{ height: 20, alignSelf: 'flex-start' }}>
                            {step.label}
                          </span>
                          <div className="main">
                            <div className="title">
                              <span className="name">{step.n}</span>
                              {step._subtitle ? <span className="muted" style={{ fontSize: 12.5 }}>{step._subtitle}</span> : null}
                              {step._error ? <span className="badge b-err"><span className="dot" />Failed</span> : null}
                            </div>
                            <div className="meta">
                              <button
                                type="button"
                                className={`expand${isOpen ? ' open' : ''}`}
                                style={{ border: 0, background: 'none', padding: 0 }}
                                onClick={() => setOpen(isOpen ? null : id)}
                              >
                                {isOpen ? 'Hide' : 'Show'} raw <ChevronDown size={12} />
                              </button>
                            </div>

                            {isOpen ? (
                              !maySeeRaw ? (
                                <div className="gate">
                                  <Lock size={13} />
                                  Raw input and output are held back by the backend unless your session carries{' '}
                                  <b>canViewRawExecutionData</b>. The summary above is what every admin sees.
                                </div>
                              ) : !showRaw ? (
                                <div className="gate">
                                  <Lock size={13} />
                                  Hidden by you — use <b>Show raw</b> above. Nothing is being withheld by the backend.
                                </div>
                              ) : (
                                <div className="raw">
                                  <div className="lbl">Input</div>
                                  <pre>{JSON.stringify(step.i, null, 2)}</pre>
                                  <div className="lbl">Output</div>
                                  <pre>{JSON.stringify(step.o, null, 2)}</pre>
                                </div>
                              )
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
                {run.ended ? (
                  <div className="step" style={{ justifyContent: 'center', gap: 9 }}>
                    <span className="tl tl-done">Done</span><b>run_end · {run.statusLabel}</b>
                  </div>
                ) : null}
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

/**
 * One person, from a company admin's side of the fence.
 *
 * Deliberately not a permission editor. A company admin editing one person's
 * grants directly is how drift starts — the department is where access is
 * decided, so this states what they hold and sends you there. The tabs it does
 * own are the two an admin actually needs from here: what this is costing, and
 * what the proxy will let them do.
 */
export function CompanyPersonDetail({ replay, toast, go }: Props) {
  const { userId } = useParams()
  const { token } = useAdminAuth()
  const companyId = useCompanyScope()
  const [r1, r2] = useStaged([260, 560], replay)
  const [tab, setTab] = useState<'activity' | 'access' | 'limits'>('activity')

  const spend = useMemberSpend(token, userId, 30, companyId)
  const directory = useDirectory()
  const runs = useRuns({ userId, limit: 10 })
  const policy = useProxyPolicy(token, userId, companyId)
  const savePolicy = useSaveProxyPolicy(token, companyId)
  const models = useProxyModels(token)
  const denials = useProxyAudit(token, companyId, { userId, decision: 'denied', limit: 5 })

  const person = directory.data.find((p) => p.userId === userId)
  const detail = spend.data
  const name = person ? displayName(person.name, person.email) : detail?.name ?? '—'
  const email = person?.email ?? detail?.email ?? ''

  if (!spend.isLoading && !directory.loading && !person && !detail) {
    return (
      <>
        <div className="crumbs">
          <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-people')}>
            <ArrowLeft size={13} />Everyone
          </button>
        </div>
        <Empty icon={Users} title="Nobody here" body="This person is not an active member of your company." />
      </>
    )
  }

  const current = policy.data
  const budget = current?.monthlyBudgetUsd ?? null
  const spent = detail?.spend30d ?? 0
  const allowed = current?.allowedModels ?? []

  /**
   * The route replaces the whole policy, so every write sends the complete
   * next state — patching one field would silently clear the others.
   */
  const write = async (patch: Partial<ProxyPolicyInput>, message: string) => {
    try {
      await savePolicy.mutateAsync({
        userId: userId!,
        input: {
          blocked: current?.blocked ?? false,
          monthlyBudgetUsd: current?.monthlyBudgetUsd ?? null,
          rateLimitRpm: current?.rateLimitRpm ?? null,
          allowedModels: current?.allowedModels ?? [],
          ...patch,
        },
      })
      toast(message)
    } catch {
      toast('Could not save that limit')
    }
  }

  const toggleModel = (id: string) => {
    const next = allowed.includes(id) ? allowed.filter((m) => m !== id) : [...allowed, id]
    // An empty list means "every model", so emptying the last one would widen
    // access rather than remove it. Refuse instead of doing the opposite.
    if (allowed.length > 0 && next.length === 0) {
      toast('At least one model must stay allowed')
      return
    }
    void write({ allowedModels: next }, 'Model access updated')
  }

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-people')}>
          <ArrowLeft size={13} />Everyone
        </button>
      </div>

      {!r1 || spend.isLoading ? <Skel w={300} h={56} /> : (
        <Fade>
          <div className="profile">
            <div className="pic">{initialsOf(person?.name ?? name, email)}</div>
            <div style={{ flex: 1 }}>
              <h1>{name}</h1>
              <div className="sub">
                <span>{email}</span>
                {person ? <><span>·</span><span>{ROLE_LABEL[person.companyRole] ?? person.companyRole}</span></> : null}
                {person?.departmentNames.length
                  ? <><span>·</span><span>{person.departmentNames.join(', ')}</span></>
                  : <><span>·</span><span>no department</span></>}
              </div>
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
                {!r2 || spend.isLoading ? <Skel w="100%" h={110} /> : (
                  <Fade>
                    <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap' }}>
                      <div>
                        <div className="ws-lbl">Cost</div>
                        <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(spent)}</div>
                      </div>
                      <div>
                        <div className="ws-lbl">Tasks</div>
                        <div className="ws-num" style={{ marginTop: 8 }}>{detail?.runs ?? 0}</div>
                      </div>
                      <div>
                        <div className="ws-lbl">Avg per task</div>
                        <div className="ws-num" style={{ marginTop: 8 }}>
                          {detail?.runs ? money(detail.avgPerRun) : '—'}
                        </div>
                      </div>
                    </div>
                    {detail?.sparkline.length ? (
                      <div style={{ marginTop: 22 }}><Spark data={detail.sparkline} /></div>
                    ) : null}
                  </Fade>
                )}
              </div>
            </Panel>

            <Panel title="Connected accounts" description="What Divo may act through on their behalf">
              {!r2 || directory.loading ? <SkelRows n={3} /> : !person ? null : (
                <Fade>
                  <div className="ws-rows">
                    {/* The directory reports these two and only these two. Listing a
                        provider it cannot speak for would be a guess. */}
                    {[
                      { name: 'Lark', on: person.larkLinked, note: person.larkLinked ? 'Identity linked' : 'Divo in Lark cannot recognise them' },
                      { name: 'Google Workspace', on: person.googleConnected, note: person.googleConnected ? 'Their own account' : 'Not connected' },
                    ].map((c) => (
                      <div className="ws-row" key={c.name}>
                        <span className="ws-ic" data-tone={c.on ? 'ok' : undefined}><Link2 size={14} /></span>
                        <div className="ws-row-main"><b>{c.name}</b><p>{c.note}</p></div>
                        {c.on
                          ? <span className="badge b-ok"><span className="dot" />On</span>
                          : <span className="ws-sub">Off</span>}
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
            {!r2 || runs.loading ? <SkelRows n={4} icon={false} /> : runs.data.length === 0 ? (
              <Empty title="Nothing has run for them" body="They have permissions but Divo has not done anything on their behalf." />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {runs.data.map((r) => (
                    <div className="ws-row click" key={r.id} onClick={() => go(`co-run:${r.id}`)}>
                      <div className="ws-row-main">
                        <b>{r.latestSummary ?? 'No summary recorded'}</b>
                        <p>{ago(r.startedAt)} · {CHANNEL_WORD[r.channel] ?? r.channel}</p>
                      </div>
                      <div className="ws-row-act">
                        <span className="ws-sub">{r.costUsd === null ? 'unattributed' : money(r.costUsd)}</span>
                        <RunStatusBadge status={r.status} />
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
        <Panel title="Where their access comes from" source="permissions">
          {!r2 || directory.loading ? <SkelRows n={3} /> : (
            <Fade>
              <div className="ws-rows">
                {person?.departmentNames.length ? person.departmentNames.map((d) => (
                  <div className="ws-row click" key={d} onClick={() => go('co-departments')}>
                    <span className="ws-ic"><Building2 size={14} /></span>
                    <div className="ws-row-main">
                      <b>{d}</b>
                      <p>Their role in this department decides what Divo may do for them</p>
                    </div>
                    <span className="ws-sub">Open</span>
                  </div>
                )) : (
                  <div style={{ padding: 18 }}>
                    <Empty
                      icon={Building2}
                      title="They are in no department"
                      body="Divo can do nothing for them until they are — a company role alone grants no tools."
                    />
                  </div>
                )}
                {person && person.managerDepartmentCount > 0 ? (
                  <div className="ws-row">
                    <span className="ws-ic" data-tone="ok"><ShieldCheck size={14} /></span>
                    <div className="ws-row-main">
                      <b>Manages {person.managerDepartmentCount} {person.managerDepartmentCount === 1 ? 'department' : 'departments'}</b>
                      <p>They can grant permissions and answer approvals for the teams they lead</p>
                    </div>
                  </div>
                ) : null}
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            Permissions are edited in the department, not here — a company admin changing one person directly is how drift starts
          </div>
        </Panel>
      ) : null}

      {tab === 'limits' ? (
        <div className="ws-stack">
          <Panel title="Spending" description="Enforced — the proxy refuses the call when the budget is reached">
            <div className="ws-panel-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="ws-num-sm">{money(spent)}</span>
                <span className="ws-sub">{budget === null ? 'no dollar budget set' : `of ${money(budget)} this month`}</span>
              </div>
              {budget !== null ? (
                <div style={{ marginTop: 12 }}><Bar pct={(spent / budget) * 100} tone="brand" /></div>
              ) : null}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 22 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>Allow Divo to work for them</div>
                  <div className="ws-sub" style={{ marginTop: 3 }}>Blocking is immediate and applies to every channel</div>
                </div>
                <Switch
                  on={!(current?.blocked ?? false)}
                  onToggle={() => void write(
                    { blocked: !(current?.blocked ?? false) },
                    current?.blocked ? `${name.split(' ')[0]} unblocked` : `${name.split(' ')[0]} blocked`,
                  )}
                  label="Allow"
                />
              </div>
            </div>
            {current?.isDefault ? (
              <div className="ws-panel-foot">
                They are on the company default — the first change here creates a policy of their own.
              </div>
            ) : null}
          </Panel>

          <Panel title="Models they may use">
            {models.isLoading ? <SkelRows n={3} icon={false} /> : (
              <div className="ws-rows">
                {(models.data ?? []).map((m) => (
                  <div className="ws-row" key={m.id}>
                    <div className="ws-row-main">
                      <b>{m.label}</b>
                      <p>{m.id} · {m.provider}</p>
                    </div>
                    <Switch
                      on={allowed.length === 0 || allowed.includes(m.id)}
                      onToggle={() => toggleModel(m.id)}
                      label={m.label}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="ws-panel-foot">
              An empty list means every model is allowed — which is why the last one cannot be switched off
            </div>
          </Panel>

          <Panel title="Recent refusals" description="Requests the proxy turned away">
            {denials.isLoading ? <SkelRows n={2} icon={false} /> : (denials.data ?? []).length === 0 ? (
              <Empty icon={Check} title="Nothing refused" body="Every request they made was allowed through." />
            ) : (
              <div className="ws-rows">
                {(denials.data ?? []).map((d) => (
                  <div className="ws-row" key={d.id}>
                    <span className="ws-ic" data-tone="err"><Ban size={14} /></span>
                    <div className="ws-row-main">
                      <b style={{ fontWeight: 400 }}>{d.reason ?? 'Refused'}</b>
                      <p>{ago(d.createdAt)} · {d.model} · HTTP {d.httpStatus}</p>
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
