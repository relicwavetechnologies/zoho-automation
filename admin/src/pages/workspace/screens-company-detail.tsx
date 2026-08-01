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
  Bar, Empty, Fade, NoAccess, PageHeader, Panel, Seg, Skel, SkelRows, Spark,
  Switch, compact, money, useStaged,
} from './ui'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useRunDetail, type RunTurnView } from '@/cursor/use-run-detail'
import { useCompanyScope, useDirectory, useMemberSpend } from '@/cursor/use-spend'
import { useProxyPolicy, useSaveProxyPolicy, type ProxyPolicyInput } from '@/cursor/use-proxy-policy'
import { useProxyAudit, useProxyModels } from '@/cursor/use-proxy'
import {
  ROLE_LABEL, ago, displayName, initialsOf, useDepartmentDetail, useRuns,
} from './data/use-company'
import { useTeamUsage } from './data/use-team'

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
  const directory = useDirectory(token, companyId)
  const runs = useRuns({ userId, limit: 10 })
  const policy = useProxyPolicy(token, userId, companyId)
  const savePolicy = useSaveProxyPolicy(token, companyId)
  const models = useProxyModels(token)
  const denials = useProxyAudit(token, companyId, { userId, decision: 'denied', limit: 5 })

  const person = directory.data?.find((p) => p.userId === userId)
  const detail = spend.data
  const name = person ? displayName(person.name, person.email) : detail?.name ?? '—'
  const email = person?.email ?? detail?.email ?? ''

  if (!spend.isLoading && !directory.isLoading && !person && !detail) {
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
              {!r2 || directory.isLoading ? <SkelRows n={3} /> : !person ? null : (
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
          {!r2 || directory.isLoading ? <SkelRows n={3} /> : (
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

/**
 * A department, from the company side.
 *
 * The manager owns this team day to day; this view is for when an admin needs
 * to reach in — usually because nobody is managing it. So the first thing it
 * answers is who can approve for these people, and the permission tabs are
 * read-only pointers back to the manager's editor rather than a second one.
 */
export function CompanyDepartmentDetail({ replay, go }: Props) {
  const { departmentId } = useParams()
  const [r1, r2] = useStaged([280, 560], replay)
  const [tab, setTab] = useState<'people' | 'roles' | 'access'>('people')
  const { data, loading, refused } = useDepartmentDetail(departmentId)
  const { usage } = useTeamUsage(departmentId)

  if (!loading && !data) {
    return (
      <>
        <div className="crumbs">
          <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-departments')}>
            <ArrowLeft size={13} />Departments
          </button>
        </div>
        {refused ? (
          <NoAccess
            what="this department"
            who="Reaching into a department you do not administer is limited to company admins and that team's manager."
          />
        ) : (
          <Empty icon={Building2} title="No such department" body="It may have been archived, or belongs to another company." />
        )}
      </>
    )
  }

  const dept = data?.department
  const members = data?.memberships ?? []
  const roles = data?.roles ?? []
  const managers = members.filter((m) => m.roleSlug === 'MANAGER')
  const spendByUser = new Map(usage.people.map((p) => [p.userId, p]))
  const overridesByUser = new Map<string, number>()
  for (const o of data?.userOverrides ?? []) overridesByUser.set(o.userId, (overridesByUser.get(o.userId) ?? 0) + 1)
  const grantsByRole = new Map<string, number>()
  for (const g of data?.toolPermissions ?? []) {
    if (g.allowed) grantsByRole.set(g.roleId, (grantsByRole.get(g.roleId) ?? 0) + 1)
  }

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={() => go('co-departments')}>
          <ArrowLeft size={13} />Departments
        </button>
      </div>

      <PageHeader
        eyebrow="Department"
        title={dept?.name ?? '—'}
        description={
          dept?.description
          ?? `${members.length} ${members.length === 1 ? 'person' : 'people'}, ${roles.length} ${roles.length === 1 ? 'role' : 'roles'}. Managers govern their own department — this view is for when you need to reach in.`
        }
      />

      {/* The one condition an admin has to act on: with no manager, every gated
          action fails closed and the person who asked is never told why. */}
      {!loading && managers.length === 0 ? (
        <div className="ws-ceiling" style={{ marginBottom: 18 }}>
          <TriangleAlert size={14} />
          <div>
            <b>Nobody manages this department.</b>{' '}
            Anything needing approval stops and waits for a manager who does not exist. Give someone the Manager
            role to unblock it.
          </div>
        </div>
      ) : null}

      {!r1 ? <Skel w="100%" h={26} /> : (
        <Fade>
          <div className="runmeta">
            <span>People <b>{members.length}</b></span>
            <span>Roles <b>{roles.length}</b></span>
            <span>Managers <b>{managers.length}</b></span>
            <span>Using Divo <b>{usage.activePeople}</b></span>
            <span>30-day cost <b style={{ color: 'var(--cur-primary)' }}>{money(usage.spendUsd)}</b></span>
          </div>
        </Fade>
      )}

      <div className="filters">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'people', label: `People · ${members.length}` },
            { value: 'roles', label: `Roles · ${roles.length}` },
            { value: 'access', label: 'Access' },
          ]}
        />
      </div>

      {tab === 'people' ? (
        <Panel source="teamPeople">
          {!r2 || loading ? <SkelRows n={5} /> : members.length === 0 ? (
            <Empty icon={Users} title="Nobody in this department" body="Divo can do nothing for a team with no members." />
          ) : (
            <Fade>
              <div className="ws-rows">
                {members.map((m) => {
                  const spend = spendByUser.get(m.userId)
                  const exceptions = overridesByUser.get(m.userId) ?? 0
                  return (
                    <div className="ws-row click" key={m.userId} onClick={() => go(`co-person:${m.userId}`)}>
                      <span className="avatar">{initialsOf(m.name, m.email)}</span>
                      <div className="ws-row-main">
                        <b>
                          {displayName(m.name, m.email)}
                          {m.roleSlug === 'MANAGER' ? <span className="ws-tag">Leads this team</span> : null}
                          {exceptions > 0 ? (
                            <span className="ws-prov" data-src="department_user_override">
                              {exceptions} personal exception{exceptions > 1 ? 's' : ''}
                            </span>
                          ) : null}
                        </b>
                        <p>{m.email} · {m.roleName}</p>
                      </div>
                      <div className="ws-row-act">
                        <span className="ws-sub">{money(spend?.spendUsd ?? 0)}</span>
                        <span className="ws-sub">{spend?.runs ?? 0} tasks</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Fade>
          )}
        </Panel>
      ) : null}

      {tab === 'roles' ? (
        <Panel source="permissions">
          {!r2 || loading ? <SkelRows n={4} /> : (
            <Fade>
              <div className="ws-rows">
                {roles.map((role) => {
                  const holders = members.filter((m) => m.roleId === role.id)
                  return (
                    <div className="ws-row" key={role.id}>
                      <span className="ws-ic"><Users size={14} /></span>
                      <div className="ws-row-main">
                        <b>
                          {role.name}
                          {role.isDefault ? <span className="ws-tag">Default</span> : null}
                          {role.isSystem ? <span className="ws-tag">Built in</span> : null}
                        </b>
                        <p>
                          {holders.length} {holders.length === 1 ? 'person' : 'people'} ·{' '}
                          {grantsByRole.get(role.id) ?? 0} action{(grantsByRole.get(role.id) ?? 0) === 1 ? '' : 's'} granted
                          {holders.length ? ` · ${holders.map((h) => displayName(h.name, h.email).split(' ')[0]).join(', ')}` : ''}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Fade>
          )}
          <div className="ws-panel-foot">
            Role grants are edited by the department's manager. The company ceiling is the only thing you set from here.
          </div>
        </Panel>
      ) : null}

      {tab === 'access' ? (
        <div className="ws-stack">
          <Panel title="What this team has been granted" description="Counted from the department's own grant rows">
            {!r2 || loading ? <SkelRows n={4} icon={false} /> : (
              <Fade>
                <div className="ws-metrics">
                  <div className="ws-metric">
                    <div className="k">Actions granted</div>
                    <div className="v">{(data?.toolPermissions ?? []).filter((p) => p.allowed).length}</div>
                    <div className="s">Across every role in this department</div>
                  </div>
                  <div className="ws-metric">
                    <div className="k">Personal exceptions</div>
                    <div className="v">{(data?.userOverrides ?? []).length}</div>
                    <div className="s">Granted to individuals, outside any role</div>
                  </div>
                  <div className="ws-metric">
                    <div className="k">Tools touched</div>
                    <div className="v">{new Set((data?.toolPermissions ?? []).map((p) => p.toolId)).size}</div>
                    <div className="s">Distinct tools with a grant row</div>
                  </div>
                </div>
              </Fade>
            )}
            <div className="ws-panel-foot">
              <ShieldCheck size={13} />
              These are what was configured. What each person can actually do is clamped by the company ceiling.
            </div>
          </Panel>

          <Panel title="Changing any of this">
            <div className="ws-panel-body">
              <p className="ws-sub" style={{ lineHeight: 1.6 }}>
                Permissions inside a department are the manager's to set, and there is deliberately no second editor
                here — two places to change the same grant is how the two disagree. Raise or lower what any team is
                allowed to grant at all from the <b>company ceiling</b>.
              </p>
              <div style={{ marginTop: 14 }}>
                <button type="button" className="btn" onClick={() => go('co-policy')}>Open the company ceiling</button>
              </div>
            </div>
          </Panel>
        </div>
      ) : null}
    </>
  )
}
