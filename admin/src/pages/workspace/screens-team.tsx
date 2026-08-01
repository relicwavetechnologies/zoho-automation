/**
 * "Your team" scope — the manager surface, and the centrepiece of this design.
 *
 * The thesis: RBAC UIs fail because they ask a human to think like the
 * database — a matrix of subjects × resources × verbs. Managers don't think in
 * grants. They think "Ananya is joining, give her what Rohan has, minus the
 * bank stuff." So this is person-first, states permissions as a sentence
 * before offering a grid, shows WHERE each permission came from, and never
 * applies an edit without previewing it as a diff.
 */
import { useMemo, useState } from 'react'
import {
  ArrowRight, Ban, Check, Clock, Copy, Gauge, Plus, Search, ShieldCheck,
  TriangleAlert, UserPlus, Users, X,
} from 'lucide-react'
import {
  ACTION_GROUPS, AWAITING_ME, PEOPLE, ROLE_GRANTS, TEAM_USAGE, TOOLS,
  ceilingAllows, resolveGrants, toolById,
  type ActionGroup, type GrantMap, type Person,
} from './fixtures'
import {
  Bar, ChangePreview, DataNote, Drawer, Empty, Fade, Matrix, PageHeader, Panel, Provenance,
  Seg, Skel, SkelRows, Switch, listPhrase, money, permissionSentence, useStaged,
  type PendingChange,
} from './ui'

type Props = { replay: number; toast: (m: string) => void; go: (screen: string) => void }

/* ══ Team overview ═════════════════════════════════════ */
export function TeamHome({ replay, toast, go }: Props) {
  const [r1, r2] = useStaged([260, 560], replay)
  const neverUsed = PEOPLE.filter((p) => p.lastActive === 'Never')
  const overrides = PEOPLE.filter((p) => Object.keys(p.overrides).length > 0)

  const attention = [
    ...AWAITING_ME.map((a) => ({
      tone: 'act' as const,
      title: a.summary,
      body: `${a.requestedBy} is waiting. ${a.detail}`,
      meta: [`Expires ${a.expiresIn}`],
      cta: 'Review',
      onClick: () => go('approvals'),
    })),
    ...(neverUsed.length
      ? [{
          tone: 'warn' as const,
          title: `${neverUsed[0].name} has never used Divo`,
          body: 'Joined 6 weeks ago with a Member role and no connected accounts. Divo cannot do anything for them yet.',
          meta: ['Joined ' + neverUsed[0].joined],
          cta: 'Open',
          onClick: () => go('people'),
        }]
      : []),
    ...(overrides.length
      ? [{
          tone: 'warn' as const,
          title: `${overrides.length} people have personal exceptions`,
          body: 'Permissions given to individuals rather than to a role drift over time and are easy to forget. Worth folding back into a role.',
          meta: overrides.map((p) => p.name),
          cta: 'Review',
          onClick: () => go('people'),
        }]
      : []),
  ]

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Your team"
        description="Six people. You decide what Divo may do for each of them, and what it must ask you first."
      />
      <div className="ws-stack">
        <Panel title="Needs you">
          {!r1 ? <SkelRows n={3} icon={false} /> : (
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

        <div className="ws-cols">
          <Panel title="People" aside={<button type="button" className="btn" onClick={() => go('people')}>Manage</button>} source="teamPeople">
            {!r2 ? <SkelRows n={4} /> : (
              <Fade>
                <div className="ws-rows">
                  {PEOPLE.slice(0, 4).map((p) => (
                    <div className="ws-row click" key={p.id} onClick={() => go('people')}>
                      <span className="avatar">{p.initials}</span>
                      <div className="ws-row-main">
                        <b>{p.name}</b>
                        <p>{p.deptRoleName} · {p.lastActive === 'Never' ? 'never used Divo' : `active ${p.lastActive}`}</p>
                      </div>
                      <span className="ws-sub">{p.runs30d} tasks</span>
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </Panel>

          <Panel title="Team cost" source="teamUsage">
            <div className="ws-panel-body">
              {!r2 ? <Skel w="100%" h={90} /> : (
                <Fade>
                  <div className="ws-num" style={{ color: 'var(--cur-primary)' }}>{money(TEAM_USAGE.spend30d)}</div>
                  <div className="ws-sub" style={{ marginTop: 6 }}>last 30 days · {TEAM_USAGE.runs30d} tasks</div>
                  <div style={{ marginTop: 20 }}>
                    {PEOPLE.slice(0, 4).map((p) => (
                      <div key={p.id} style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                          <span>{p.name.split(' ')[0]}</span>
                          <span className="ws-sub">{money(p.spend30d)}</span>
                        </div>
                        <Bar pct={(p.spend30d / TEAM_USAGE.spend30d) * 100} />
                      </div>
                    ))}
                  </div>
                </Fade>
              )}
            </div>
            <div className="ws-panel-foot">
              <DataNote source="teamUsage" />
              No spend route accepts a department — team totals are net-new
            </div>
          </Panel>
        </div>
      </div>
    </>
  )
}

/* ══ People — person-first permissions ═════════════════ */
export function TeamPeople({ replay, toast }: Props) {
  const [r1] = useStaged([300], replay)
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const list = useMemo(
    () => PEOPLE.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [query],
  )

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="People"
        description="Open anyone to see what Divo can do for them, in plain English, and change it."
        actions={<button type="button" className="btn primary" onClick={() => toast('Pick someone to add')}><UserPlus size={14} />Add someone</button>}
      />
      <div className="filters">
        <div className="search" style={{ maxWidth: 300 }}>
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find someone"
            style={{ border: 0, background: 'none', outline: 'none', flex: 1, fontSize: 13, color: 'var(--cur-ink)', fontFamily: 'inherit' }}
          />
        </div>
      </div>

      <Panel source="teamPeople">
        {!r1 ? <SkelRows n={6} /> : list.length === 0 ? (
          <Empty icon={Users} title="Nobody matches" body="Try a different name." />
        ) : (
          <Fade>
            <div className="ws-rows">
              {list.map((p) => {
                const overrideCount = Object.values(p.overrides).reduce((n, a) => n + Object.keys(a).length, 0)
                return (
                  <div className="ws-row click" key={p.id} onClick={() => setOpen(p.id)}>
                    <span className="avatar">{p.initials}</span>
                    <div className="ws-row-main">
                      <b>
                        {p.name}
                        {p.deptRole === 'MANAGER' ? <span className="ws-tag">Leads this team</span> : null}
                        {overrideCount > 0 ? <span className="ws-prov" data-src="department_user_override">{overrideCount} personal exception{overrideCount > 1 ? 's' : ''}</span> : null}
                      </b>
                      <p>{p.title} · {p.deptRoleName} · {p.lastActive === 'Never' ? 'never used Divo' : `active ${p.lastActive}`}</p>
                    </div>
                    <div className="ws-row-act">
                      <span className="ws-sub">{p.runs30d} tasks</span>
                      <span className="ws-sub">{money(p.spend30d)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </Fade>
        )}
      </Panel>

      {open ? <PersonDrawer personId={open} onClose={() => setOpen(null)} toast={toast} /> : null}
    </>
  )
}

/**
 * The centrepiece. Sentence first, grid second, diff before saving.
 * Nothing here applies immediately — a permission change is a decision, and
 * decisions want a confirm step with the consequence spelled out.
 */
function PersonDrawer({ personId, onClose, toast }: { personId: string; onClose: () => void; toast: (m: string) => void }) {
  const person = PEOPLE.find((p) => p.id === personId)!
  const [tab, setTab] = useState<'summary' | 'detail'>('summary')
  const [pending, setPending] = useState<PendingChange[]>([])
  const [copyFrom, setCopyFrom] = useState<string | null>(null)

  const base = resolveGrants(person)
  const grants: GrantMap = useMemo(() => {
    const next: GrantMap = {}
    for (const [toolId, actions] of Object.entries(base)) next[toolId] = { ...actions }
    for (const c of pending) {
      next[c.toolId] = { ...(next[c.toolId] ?? {}), [c.action]: { allowed: c.next, source: 'department_user_override' } }
    }
    return next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, pending])

  const { can, cannot } = permissionSentence(person)

  const toggle = (toolId: string, action: ActionGroup) => {
    if (!ceilingAllows(toolId, action)) return
    const current = Boolean(grants[toolId]?.[action]?.allowed)
    setPending((prev) => {
      const without = prev.filter((c) => !(c.toolId === toolId && c.action === action))
      const original = Boolean(base[toolId]?.[action]?.allowed)
      if (original === !current) return without // toggled back to where it started
      return [...without, { toolId, action, next: !current }]
    })
  }

  const applyCopy = (sourceId: string) => {
    const source = PEOPLE.find((p) => p.id === sourceId)!
    const target = resolveGrants(source)
    const changes: PendingChange[] = []
    for (const tool of TOOLS) {
      for (const action of tool.actions) {
        const want = Boolean(target[tool.id]?.[action]?.allowed)
        const have = Boolean(base[tool.id]?.[action]?.allowed)
        if (want === have) continue
        changes.push({ toolId: tool.id, action, next: want, blocked: want && !ceilingAllows(tool.id, action) })
      }
    }
    setPending(changes.filter((c) => !c.blocked))
    setCopyFrom(null)
    setTab('summary')
    toast(`Matched to ${source.name.split(' ')[0]} — review before saving`)
  }

  const isManager = person.deptRole === 'MANAGER'

  return (
    <Drawer
      title={person.name}
      subtitle={`${person.title} · ${person.deptRoleName} · joined ${person.joined}`}
      onClose={onClose}
      footer={
        pending.length === 0 ? (
          <button type="button" className="btn" onClick={onClose}>Close</button>
        ) : undefined
      }
    >
      {isManager ? (
        <div className="ws-ceiling" style={{ marginBottom: 18 }}>
          <ShieldCheck size={14} />
          <div>
            <b>{person.name.split(' ')[0]} leads this team alongside you.</b>{' '}
            Managers cannot change each other's access — only a company admin can.
          </div>
        </div>
      ) : null}

      <div className="ws-seg" style={{ marginBottom: 20 }}>
        <button type="button" className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>Summary</button>
        <button type="button" className={tab === 'detail' ? 'on' : ''} onClick={() => setTab('detail')}>Every action</button>
      </div>

      {tab === 'summary' ? (
        <>
          <p className="ws-sentence">
            Divo can <b>{listPhrase(can, 5)}</b> for {person.name.split(' ')[0]}.
          </p>
          {cannot.length ? (
            <p className="ws-sentence" style={{ marginTop: 12 }}>
              <span className="neg">It cannot {listPhrase(cannot, 3)}.</span>
            </p>
          ) : null}
          <p className="ws-sentence-note">
            Most of this comes from the <b>{person.deptRoleName}</b> role.
            {Object.keys(person.overrides).length
              ? ' Some was granted to them personally — shown in orange below.'
              : ' Nothing has been granted to them personally.'}
          </p>

          {Object.keys(person.overrides).length ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 26 }}>
                <span className="ws-lbl">Personal exceptions</span>
                <DataNote source="overrideRemoval" />
              </div>
              <div className="ws-rows" style={{ marginTop: 6 }}>
                {Object.entries(person.overrides).flatMap(([toolId, actions]) =>
                  Object.entries(actions).map(([action, grant]) => (
                    <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={`${toolId}:${action}`}>
                      <div className="ws-row-main">
                        <b style={{ fontWeight: 400 }}>
                          {grant?.allowed ? 'Can ' : 'Cannot '}
                          {toolById(toolId)?.verb[action as ActionGroup] ?? `${action} ${toolById(toolId)?.name}`}
                        </b>
                        <p>
                          Granted directly, outside the {person.deptRoleName} role — so it wins even if the role changes
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        title="Drops the exception so they follow the role again. Needs a DELETE route — the backend can only flip an override, not lift it."
                        onClick={() => toast('Would drop the exception and follow the role')}
                      >
                        Use role instead
                      </button>
                    </div>
                  )),
                )}
              </div>
            </>
          ) : null}

          {!isManager ? (
            <>
              <div className="ws-lbl" style={{ marginTop: 26 }}>Shortcuts</div>
              <div className="ws-rows" style={{ marginTop: 6 }}>
                <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <span className="ws-ic"><Copy size={14} /></span>
                  <div className="ws-row-main">
                    <b>Match someone else's access</b>
                    <p>The way most people actually think about this — "give them what Rohan has".</p>
                  </div>
                  <button type="button" className="btn" onClick={() => setCopyFrom('pick')}>Choose</button>
                </div>
                <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <span className="ws-ic"><Users size={14} /></span>
                  <div className="ws-row-main">
                    <b>Change their role</b>
                    <p>Currently {person.deptRoleName}. Changing the role changes everyone who holds it.</p>
                  </div>
                  <button type="button" className="btn" onClick={() => toast('Role picker')}>Change</button>
                </div>
              </div>
            </>
          ) : null}

          {copyFrom ? (
            <div className="ws-panel" style={{ marginTop: 16 }}>
              <header><div className="ws-panel-t"><h2>Match whose access?</h2></div>
                <button type="button" className="icon-btn" onClick={() => setCopyFrom(null)}><X size={14} /></button>
              </header>
              <div className="ws-rows">
                {PEOPLE.filter((p) => p.id !== person.id && p.deptRole !== 'MANAGER').map((p) => (
                  <div className="ws-row click" key={p.id} onClick={() => applyCopy(p.id)}>
                    <span className="avatar">{p.initials}</span>
                    <div className="ws-row-main"><b>{p.name}</b><p>{p.deptRoleName}</p></div>
                    <ArrowRight size={14} className="muted" />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="ws-ceiling" style={{ marginBottom: 16 }}>
            <TriangleAlert size={14} />
            <div>
              Locked cells are blocked by <b>company policy</b>, above your level. Turning them on here would do
              nothing — the backend clamps a team grant to the company ceiling.
            </div>
          </div>
          <Matrix grants={grants} onToggle={isManager ? undefined : toggle} readOnly={isManager} tools={TOOLS.filter((t) => !t.adminOnly)} />
        </>
      )}

      {pending.length > 0 ? (
        <div style={{ marginTop: 22 }}>
          <ChangePreview
            person={person}
            changes={pending}
            onCancel={() => setPending([])}
            onApply={() => { toast(`${pending.length} change${pending.length > 1 ? 's' : ''} saved for ${person.name.split(' ')[0]}`); setPending([]) }}
          />
        </div>
      ) : null}
    </Drawer>
  )
}

/* ══ Roles ═════════════════════════════════════════════ */
export function TeamRoles({ replay, toast }: Props) {
  const [r1] = useStaged([300], replay)
  const [role, setRole] = useState<'MEMBER' | 'ANALYST'>('MEMBER')
  const [pending, setPending] = useState<PendingChange[]>([])
  const base = ROLE_GRANTS[role]
  const holders = PEOPLE.filter((p) => p.deptRole === role)

  const grants: GrantMap = useMemo(() => {
    const next: GrantMap = {}
    for (const [toolId, actions] of Object.entries(base)) next[toolId] = { ...actions }
    for (const c of pending) next[c.toolId] = { ...(next[c.toolId] ?? {}), [c.action]: { allowed: c.next, source: 'department_role' } }
    return next
  }, [base, pending])

  const toggle = (toolId: string, action: ActionGroup) => {
    if (!ceilingAllows(toolId, action)) return
    const current = Boolean(grants[toolId]?.[action]?.allowed)
    setPending((prev) => {
      const without = prev.filter((c) => !(c.toolId === toolId && c.action === action))
      const original = Boolean(base[toolId]?.[action]?.allowed)
      if (original === !current) return without
      return [...without, { toolId, action, next: !current }]
    })
  }

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Roles"
        description="A role is a starting point, not a cage. Change one here and it changes for everyone who holds it."
        actions={<button type="button" className="btn" onClick={() => toast('New role')}><Plus size={14} />New role</button>}
      />
      <div className="filters">
        <Seg
          value={role}
          onChange={(v) => { setRole(v); setPending([]) }}
          options={[
            { value: 'MEMBER', label: `Member (${PEOPLE.filter((p) => p.deptRole === 'MEMBER').length})` },
            { value: 'ANALYST', label: `Analyst (${PEOPLE.filter((p) => p.deptRole === 'ANALYST').length})` },
          ]}
        />
      </div>

      <div className="ws-stack">
        {pending.length > 0 ? (
          <div className="ws-diff">
            <div className="ws-diff-h">
              <TriangleAlert size={14} style={{ color: 'var(--ws-warning)' }} />
              This changes access for {holders.length} {holders.length === 1 ? 'person' : 'people'} at once
            </div>
            <div className="ws-diff-l">
              {pending.map((c) => (
                <div className="ws-diff-i" key={`${c.toolId}:${c.action}`} data-k={c.next ? 'add' : 'remove'}>
                  <span className="sg">{c.next ? '+' : '−'}</span>
                  <span>{c.next ? 'Can' : 'Can no longer'} <b>{toolById(c.toolId)?.verb[c.action] ?? `${c.action} ${toolById(c.toolId)?.name}`}</b></span>
                  <small>{holders.map((h) => h.name.split(' ')[0]).join(', ')}</small>
                </div>
              ))}
            </div>
            <div className="ws-diff-f">
              <button type="button" className="btn" onClick={() => setPending([])}>Discard</button>
              <button type="button" className="btn primary" onClick={() => { toast(`Role updated for ${holders.length} people`); setPending([]) }}>
                Apply to {holders.length}
              </button>
            </div>
          </div>
        ) : null}

        <Panel
          title={role === 'MEMBER' ? 'Member' : 'Analyst'}
          description={`${holders.length} people · ${holders.map((h) => h.name.split(' ')[0]).join(', ')}`}
          source="permissions"
        >
          <div className="ws-panel-body">
            {!r1 ? <SkelRows n={6} icon={false} /> : (
              <Fade><Matrix grants={grants} onToggle={toggle} tools={TOOLS.filter((t) => !t.adminOnly)} /></Fade>
            )}
          </div>
          <div className="ws-panel-foot">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span className="ws-cell" data-locked="true" style={{ width: 16, height: 16, pointerEvents: 'none' }} />
              Blocked by company policy — ask an admin to raise the ceiling
            </span>
          </div>
        </Panel>
      </div>
    </>
  )
}

/* ══ What Divo must ask you first ══════════════════════ */
export function TeamApprovalPolicy({ replay, toast }: Props) {
  const [r1] = useStaged([280], replay)
  const [enabled, setEnabled] = useState(true)
  const [gated, setGated] = useState<string[]>(['googleGmail:send', 'zohoBooks:update', 'googleDrive:delete'])

  const toggle = (key: string) => {
    setGated((g) => (g.includes(key) ? g.filter((k) => k !== key) : [...g, key]))
    toast('Approval policy updated')
  }

  const gateable = TOOLS.filter((t) => !t.adminOnly).flatMap((t) =>
    t.actions.filter((a) => a !== 'read').map((a) => ({ key: `${t.id}:${a}`, tool: t, action: a })),
  )

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="What Divo must ask you first"
        description="Anything ticked here pauses and waits for your approval before it happens. Reading is never gated."
      />
      <div className="ws-stack">
        <Panel>
          <div className="ws-panel-body" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Ask me before risky actions</div>
              <p className="ws-sub" style={{ marginTop: 4, lineHeight: 1.5 }}>
                When off, Divo acts immediately for everyone in Finance, within whatever their role allows.
              </p>
            </div>
            <Switch on={enabled} onToggle={() => { setEnabled((v) => !v); toast(enabled ? 'Approvals off' : 'Approvals on') }} label="Approvals" />
          </div>
        </Panel>

        {enabled ? (
          <Panel title="Gated actions" description={`${gated.length} of ${gateable.length} actions need you`} source="permissions">
            {!r1 ? <SkelRows n={5} icon={false} /> : (
              <Fade>
                <div className="ws-rows">
                  {gateable.slice(0, 12).map(({ key, tool, action }) => (
                    <div className="ws-row" key={key}>
                      <div className="ws-row-main">
                        <b style={{ fontWeight: 400 }}>{tool.verb[action] ?? `${action} ${tool.name}`}</b>
                        <p>{tool.name} · {action}</p>
                      </div>
                      <Switch on={gated.includes(key)} onToggle={() => toggle(key)} label={key} />
                    </div>
                  ))}
                </div>
              </Fade>
            )}
            <div className="ws-panel-foot">
              <Clock size={13} />
              Requests expire after an hour. If you miss one, Divo stops and does nothing.
            </div>
          </Panel>
        ) : (
          <Empty icon={ShieldCheck} title="Nothing is gated" body="Divo will act without asking, limited only by each person's role." />
        )}
      </div>
    </>
  )
}

/* ══ Team usage ════════════════════════════════════════ */
export function TeamUsage({ replay }: Props) {
  const [r1] = useStaged([320], replay)
  return (
    <>
      <PageHeader eyebrow="Finance" title="Team usage" description="What Divo did for your team, and what it cost." />
      <div className="ws-stack">
        <div className="ws-ceiling">
          <TriangleAlert size={14} />
          <div>
            <b>This whole page is designed, not built.</b> No spend or execution route in the backend accepts a
            department, and the manager role has no read path at all. The data exists and is indexed per person —
            aggregating it by team is net-new work.
          </div>
        </div>

        <div className="ws-cols">
          <Panel title="Cost by person" source="teamUsage">
            {!r1 ? <SkelRows n={5} icon={false} /> : (
              <Fade>
                <div className="ws-panel-body">
                  {PEOPLE.map((p) => (
                    <div key={p.id} style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 13 }}>
                        <span>{p.name}</span>
                        <span className="ws-sub">{money(p.spend30d)} · {p.runs30d} tasks</span>
                      </div>
                      <Bar pct={(p.spend30d / TEAM_USAGE.spend30d) * 100} tone={p.spend30d > 40 ? 'brand' : undefined} />
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </Panel>

          <Panel title="Summary" source="teamUsage">
            <div className="ws-panel-body">
              {!r1 ? <Skel w="100%" h={120} /> : (
                <Fade>
                  <div className="ws-lbl">30-day cost</div>
                  <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(TEAM_USAGE.spend30d)}</div>
                  <div style={{ marginTop: 22 }}>
                    <div className="kv"><span className="k">Tasks</span><span className="v">{TEAM_USAGE.runs30d}</span></div>
                    <div className="kv"><span className="k">Using Divo</span><span className="v">{TEAM_USAGE.activePeople} of {TEAM_USAGE.totalPeople}</span></div>
                    <div className="kv"><span className="k">Highest</span><span className="v">{TEAM_USAGE.topSpender}</span></div>
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
