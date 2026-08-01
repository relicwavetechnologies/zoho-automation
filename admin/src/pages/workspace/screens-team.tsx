/**
 * "Your team" scope — the manager surface, and the centrepiece of this design.
 *
 * The thesis: RBAC UIs fail because they ask a human to think like the
 * database — a matrix of subjects × resources × verbs. Managers don't think in
 * grants. They think "Ananya is joining, give her what Rohan has, minus the
 * bank stuff." So this is person-first, states permissions as a sentence
 * before offering a grid, shows WHERE each permission came from, and never
 * applies an edit without previewing it as a diff.
 *
 * All of it now runs on the real permission snapshot, which turns out to carry
 * more than the design assumed: for every person and action it reports what was
 * configured, where that came from, what they can *actually* do, and — when
 * those disagree — which company rule is holding it down. So a locked cell here
 * names the real reason rather than guessing at a ceiling.
 */
import { useMemo, useState } from 'react'
import {
  ArrowRight, Check, Clock, Copy, Lock, Plus, Search, ShieldCheck,
  TriangleAlert, UserPlus, Users,
} from 'lucide-react'
import {
  Bar, DataNote, Drawer, Empty, Fade, PageHeader, Panel, Seg, Skel, SkelRows, Switch,
  listPhrase, money, useStaged,
} from './ui'
import {
  useApprovalPolicy, useDepartment, useDepartmentMatrix, useMyManagedDepartment, useTeamUsage,
  type MemberActionState, type RoleActionState, type ToolScopeSnapshot,
} from './data/use-team'
import { useApprovals, expiryLabel } from './data/use-approvals'

type Props = { replay: number; toast: (m: string) => void; go: (screen: string) => void }

/* ══ Shared reading of the snapshot ════════════════════ */

/** One cell: is it on, where did that come from, and can it be changed here. */
type Cell = {
  on: boolean
  /** Configured here but suppressed by a company rule — the interesting case. */
  blocked: boolean
  blockNote: string | null
  source: 'department_role' | 'department_user_override' | 'company_default'
  isException: boolean
}

const BLOCK_NOTE: Record<string, string> = {
  company_tool_disabled: 'Company policy switches this tool off for members',
  company_action_disabled: 'Company policy blocks this action for members',
}

const cellFromMember = (state: MemberActionState | undefined): Cell => ({
  on: Boolean(state?.effectiveAllowed),
  blocked: Boolean(state && state.configuredAllowed && !state.effectiveAllowed),
  blockNote: state?.effectiveBlockReason ? BLOCK_NOTE[state.effectiveBlockReason] ?? null : null,
  source: state?.configuredProvenance === 'member_override'
    ? 'department_user_override'
    : state?.configuredProvenance === 'department_role' ? 'department_role' : 'company_default',
  isException: state?.provenance === 'override',
})

const cellFromRole = (state: RoleActionState | undefined): Cell => {
  const blocked = state?.companyPolicyStatus === 'company_tool_blocks_all_current_members'
    || state?.companyPolicyStatus === 'company_action_blocks_all_current_members'
  return {
    on: Boolean(state?.configuredAllowed),
    blocked: Boolean(state?.configuredAllowed) && blocked,
    blockNote: blocked
      ? state?.companyPolicyStatus === 'company_tool_blocks_all_current_members'
        ? 'Company policy switches this tool off for everyone in this role'
        : 'Company policy blocks this action for everyone in this role'
      : null,
    source: state?.configuredProvenance === 'department_role' ? 'department_role' : 'company_default',
    isException: false,
  }
}

/**
 * Tools down, actions across.
 *
 * Columns come from the union of what the tools actually support rather than a
 * fixed list, so a grid never shows a column no row can use.
 */
function ToolMatrix({ tools, cellFor, onToggle, readOnly }: {
  tools: ToolScopeSnapshot[]
  cellFor: (tool: ToolScopeSnapshot, action: string) => Cell
  onToggle?: (tool: ToolScopeSnapshot, action: string, cell: Cell) => void
  readOnly?: boolean
}) {
  const columns = useMemo(() => {
    const seen: string[] = []
    for (const tool of tools) for (const action of tool.supportedActions) if (!seen.includes(action)) seen.push(action)
    return seen
  }, [tools])

  if (tools.length === 0) return <Empty title="No configurable tools" body="Nothing in this team's toolset can be turned on or off." />

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="ws-matrix">
        <thead>
          <tr>
            <th>Tool</th>
            {columns.map((a) => <th key={a} className="act">{a}</th>)}
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.tool.toolId}>
              <td><span style={{ fontWeight: 500 }}>{tool.tool.name}</span></td>
              {columns.map((action) => {
                if (!tool.supportedActions.includes(action)) {
                  return <td key={action} className="act"><span className="ws-cell-na">·</span></td>
                }
                const cell = cellFor(tool, action)
                const label = tool.actionLabels[action] ?? `${action} ${tool.tool.name}`
                return (
                  <td key={action} className="act">
                    <button
                      type="button"
                      className="ws-cell"
                      data-on={cell.on}
                      data-src={cell.source}
                      data-locked={cell.blocked || readOnly}
                      disabled={readOnly}
                      title={cell.blocked ? `${cell.blockNote} — turning this on here changes nothing` : label}
                      onClick={() => onToggle?.(tool, action, cell)}
                    >
                      {cell.blocked ? <Lock size={11} /> : cell.on ? <Check size={13} /> : null}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** "Divo can send email and read the ledger for Ananya." */
function sentenceFor(tools: ToolScopeSnapshot[], userId: string): { can: string[]; cannot: string[] } {
  const can: string[] = []
  const cannot: string[] = []
  for (const tool of tools) {
    for (const action of tool.supportedActions) {
      const state = tool.memberActionStates.find((s) => s.userId === userId && s.actionGroup === action)
      const label = tool.actionLabels[action] ?? `${action} ${tool.tool.name}`
      if (state?.effectiveAllowed) can.push(label)
      // Only the destructive half is worth saying out loud — listing every
      // ungranted read turns the sentence into another matrix.
      else if (action !== 'read') cannot.push(label)
    }
  }
  return { can, cannot: cannot.slice(0, 6) }
}

const initialsOf = (name: string | null, email: string) =>
  (name ?? email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')

const displayName = (name: string | null, email: string) => name ?? email.split('@')[0] ?? email
const firstName = (name: string | null, email: string) => displayName(name, email).split(' ')[0]!

/** Nothing to manage is a real state, not a loading one — say which. */
const NoTeam = () => (
  <Empty
    icon={Users}
    title="You don't lead a team"
    body="This scope appears for department managers. Ask a company admin to make you one."
  />
)

/* ══ Team overview ═════════════════════════════════════ */
export function TeamHome({ replay, go }: Props) {
  const dept = useMyManagedDepartment()
  const [r1, r2] = useStaged([260, 560], replay)
  const { snapshot, loading } = useDepartment(dept?.id)
  const { usage } = useTeamUsage(dept?.id)
  const { coverage } = useDepartmentMatrix(dept?.id)
  const { awaitingMe } = useApprovals()

  if (!dept) return <NoTeam />

  const people = snapshot?.memberships ?? []
  const spendByUser = new Map(usage.people.map((p) => [p.userId, p]))
  const idle = usage.people.filter((p) => p.runs === 0)
  const exceptions = coverage?.tools.reduce((n, t) => n + t.exceptionCount, 0) ?? 0

  const attention = [
    ...awaitingMe.map((a) => ({
      tone: 'act' as const,
      title: a.description.summary,
      body: `${a.requestedByName} is waiting. ${a.description.detail ?? ''}`.trim(),
      meta: [expiryLabel(a.expiresAt)?.text].filter((m): m is string => Boolean(m)),
      cta: 'Review',
      onClick: () => go('approvals'),
    })),
    ...(idle.length
      ? [{
          tone: 'warn' as const,
          title: idle.length === 1
            ? `${displayName(idle[0]!.name, idle[0]!.email)} has not used Divo`
            : `${idle.length} people have not used Divo`,
          body: 'They are in the team and have permissions, but nothing has run for them in the last 30 days.',
          meta: idle.slice(0, 4).map((p) => displayName(p.name, p.email)),
          cta: 'Open',
          onClick: () => go('people'),
        }]
      : []),
    ...(exceptions > 0
      ? [{
          tone: 'warn' as const,
          title: `${exceptions} personal exception${exceptions > 1 ? 's' : ''} in this team`,
          body: 'Permissions given to individuals rather than to a role drift over time and are easy to forget. Worth folding back into a role.',
          meta: [],
          cta: 'Review',
          onClick: () => go('people'),
        }]
      : []),
  ]

  return (
    <>
      <PageHeader
        eyebrow={dept.name}
        title="Your team"
        description={`${people.length} ${people.length === 1 ? 'person' : 'people'}. You decide what Divo may do for each of them, and what it must ask you first.`}
      />
      <div className="ws-stack">
        <Panel title="Needs you">
          {!r1 ? <SkelRows n={3} icon={false} /> : attention.length === 0 ? (
            <Empty icon={ShieldCheck} title="Nothing needs you" body="No approvals waiting, and nobody stuck." />
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

        <div className="ws-cols">
          <Panel title="People" aside={<button type="button" className="btn" onClick={() => go('people')}>Manage</button>} source="teamPeople">
            {!r2 || loading ? <SkelRows n={4} /> : (
              <Fade>
                <div className="ws-rows">
                  {people.slice(0, 4).map((p) => {
                    const spend = spendByUser.get(p.userId)
                    return (
                      <div className="ws-row click" key={p.userId} onClick={() => go('people')}>
                        <span className="avatar">{initialsOf(p.name, p.email)}</span>
                        <div className="ws-row-main">
                          <b>{displayName(p.name, p.email)}</b>
                          <p>{p.roleName ?? 'Member'}{spend && spend.runs === 0 ? ' · never used Divo' : ''}</p>
                        </div>
                        <span className="ws-sub">{spend?.runs ?? 0} tasks</span>
                      </div>
                    )
                  })}
                </div>
              </Fade>
            )}
          </Panel>

          <Panel title="Team cost" source="teamUsage">
            <div className="ws-panel-body">
              {!r2 ? <Skel w="100%" h={90} /> : (
                <Fade>
                  <div className="ws-num" style={{ color: 'var(--cur-primary)' }}>{money(usage.spendUsd)}</div>
                  <div className="ws-sub" style={{ marginTop: 6 }}>last {usage.days} days · {usage.runs} tasks</div>
                  <div style={{ marginTop: 20 }}>
                    {usage.people.slice(0, 4).map((p) => (
                      <div key={p.userId} style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                          <span>{firstName(p.name, p.email)}</span>
                          <span className="ws-sub">{money(p.spendUsd)}</span>
                        </div>
                        <Bar pct={usage.spendUsd > 0 ? (p.spendUsd / usage.spendUsd) * 100 : 0} />
                      </div>
                    ))}
                  </div>
                </Fade>
              )}
            </div>
            <div className="ws-panel-foot"><DataNote source="teamUsage" /></div>
          </Panel>
        </div>
      </div>
    </>
  )
}

/* ══ People — person-first permissions ═════════════════ */
export function TeamPeople({ replay, toast }: Props) {
  const dept = useMyManagedDepartment()
  const [r1] = useStaged([300], replay)
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const { snapshot, loading } = useDepartment(dept?.id)
  const { usage } = useTeamUsage(dept?.id)
  const matrix = useDepartmentMatrix(dept?.id)

  const people = snapshot?.memberships ?? []
  const list = useMemo(
    () => people.filter((p) => displayName(p.name, p.email).toLowerCase().includes(query.toLowerCase())),
    [people, query],
  )

  if (!dept) return <NoTeam />

  const spendByUser = new Map(usage.people.map((p) => [p.userId, p]))
  const exceptionsFor = (userId: string) => matrix.tools.reduce(
    (n, tool) => n + tool.memberActionStates.filter((s) => s.userId === userId && s.provenance === 'override').length, 0,
  )

  return (
    <>
      <PageHeader
        eyebrow={dept.name}
        title="People"
        description="Open anyone to see what Divo can do for them, in plain English, and change it."
        actions={<button type="button" className="btn primary" onClick={() => toast('Adding people is a company-admin action')}><UserPlus size={14} />Add someone</button>}
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
        {!r1 || loading ? <SkelRows n={6} /> : list.length === 0 ? (
          <Empty icon={Users} title="Nobody matches" body="Try a different name." />
        ) : (
          <Fade>
            <div className="ws-rows">
              {list.map((p) => {
                const count = exceptionsFor(p.userId)
                const spend = spendByUser.get(p.userId)
                return (
                  <div className="ws-row click" key={p.userId} onClick={() => setOpen(p.userId)}>
                    <span className="avatar">{initialsOf(p.name, p.email)}</span>
                    <div className="ws-row-main">
                      <b>
                        {displayName(p.name, p.email)}
                        {p.roleSlug === 'MANAGER' ? <span className="ws-tag">Leads this team</span> : null}
                        {count > 0 ? <span className="ws-prov" data-src="department_user_override">{count} personal exception{count > 1 ? 's' : ''}</span> : null}
                      </b>
                      <p>{p.email} · {p.roleName ?? 'Member'}{spend && spend.runs === 0 ? ' · never used Divo' : ''}</p>
                    </div>
                    <div className="ws-row-act">
                      <span className="ws-sub">{spend?.runs ?? 0} tasks</span>
                      <span className="ws-sub">{money(spend?.spendUsd ?? 0)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </Fade>
        )}
      </Panel>

      {open ? (
        <PersonDrawer
          userId={open}
          onClose={() => setOpen(null)}
          toast={toast}
          matrix={matrix}
          people={people}
        />
      ) : null}
    </>
  )
}

/**
 * The centrepiece. Sentence first, grid second, diff before saving.
 *
 * Nothing here applies immediately — a permission change is a decision, and
 * decisions want a confirm step with the consequence spelled out. The pending
 * set is written one call per change on apply, because each grant is its own
 * row on the backend and there is no batch route to fake atomicity with.
 */
function PersonDrawer({ userId, onClose, toast, matrix, people }: {
  userId: string
  onClose: () => void
  toast: (m: string) => void
  matrix: ReturnType<typeof useDepartmentMatrix>
  people: { userId: string; name: string | null; email: string; roleSlug?: string; roleName?: string }[]
}) {
  const person = people.find((p) => p.userId === userId)
  const [tab, setTab] = useState<'summary' | 'detail'>('summary')
  const [pending, setPending] = useState<{ toolId: string; action: string; next: boolean }[]>([])
  const [copyFrom, setCopyFrom] = useState(false)
  const [saving, setSaving] = useState(false)

  if (!person) return null
  const isManager = person.roleSlug === 'MANAGER'
  const { can, cannot } = sentenceFor(matrix.tools, userId)

  const stateOf = (tool: ToolScopeSnapshot, action: string) =>
    tool.memberActionStates.find((s) => s.userId === userId && s.actionGroup === action)

  const cellFor = (tool: ToolScopeSnapshot, action: string): Cell => {
    const cell = cellFromMember(stateOf(tool, action))
    const edit = pending.find((c) => c.toolId === tool.tool.toolId && c.action === action)
    return edit ? { ...cell, on: edit.next, source: 'department_user_override', isException: true } : cell
  }

  const toggle = (tool: ToolScopeSnapshot, action: string, cell: Cell) => {
    if (cell.blocked) return
    const configured = Boolean(stateOf(tool, action)?.effectiveAllowed)
    setPending((prev) => {
      const without = prev.filter((c) => !(c.toolId === tool.tool.toolId && c.action === action))
      const next = !cell.on
      return configured === next ? without : [...without, { toolId: tool.tool.toolId, action, next }]
    })
  }

  const exceptions = matrix.tools.flatMap((tool) =>
    tool.memberActionStates
      .filter((s) => s.userId === userId && s.provenance === 'override')
      .map((s) => ({ tool, state: s })),
  )

  /** "Give them what Rohan has" — the way managers actually think about this. */
  const applyCopy = (sourceId: string) => {
    const source = people.find((p) => p.userId === sourceId)!
    const changes: { toolId: string; action: string; next: boolean }[] = []
    for (const tool of matrix.tools) {
      for (const action of tool.supportedActions) {
        const want = Boolean(stateOfUser(tool, sourceId, action)?.effectiveAllowed)
        const have = Boolean(stateOf(tool, action)?.effectiveAllowed)
        const blocked = cellFromMember(stateOf(tool, action)).blocked
        // A grant the company ceiling suppresses would save and do nothing, so
        // it is dropped rather than shown as a change that will not happen.
        if (want !== have && !blocked) changes.push({ toolId: tool.tool.toolId, action, next: want })
      }
    }
    setPending(changes)
    setCopyFrom(false)
    setTab('summary')
    toast(`Matched to ${firstName(source.name, source.email)} — review before saving`)
  }

  const apply = async () => {
    setSaving(true)
    try {
      for (const change of pending) {
        await matrix.setMemberAction(change.toolId, userId, change.action, change.next)
      }
      toast(`${pending.length} change${pending.length > 1 ? 's' : ''} saved for ${firstName(person.name, person.email)}`)
      setPending([])
    } catch {
      toast('Could not save every change — reopen to see what landed')
    } finally {
      setSaving(false)
    }
  }

  const lift = async (toolId: string, action: string) => {
    try {
      await matrix.clearMemberAction(toolId, userId, action)
      toast('Exception removed — they follow the role again')
    } catch {
      toast('Could not remove that exception')
    }
  }

  return (
    <Drawer
      title={displayName(person.name, person.email)}
      subtitle={`${person.email} · ${person.roleName ?? 'Member'}`}
      onClose={onClose}
      footer={pending.length === 0 ? <button type="button" className="btn" onClick={onClose}>Close</button> : undefined}
    >
      {isManager ? (
        <div className="ws-ceiling" style={{ marginBottom: 18 }}>
          <ShieldCheck size={14} />
          <div>
            <b>{firstName(person.name, person.email)} leads this team alongside you.</b>{' '}
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
          {can.length ? (
            <p className="ws-sentence">
              Divo can <b>{listPhrase(can, 5)}</b> for {firstName(person.name, person.email)}.
            </p>
          ) : (
            <p className="ws-sentence">
              Divo cannot do anything for {firstName(person.name, person.email)} yet.
            </p>
          )}
          {cannot.length ? (
            <p className="ws-sentence" style={{ marginTop: 12 }}>
              <span className="neg">It cannot {listPhrase(cannot, 3)}.</span>
            </p>
          ) : null}
          <p className="ws-sentence-note">
            Most of this comes from the <b>{person.roleName ?? 'Member'}</b> role.
            {exceptions.length
              ? ' Some was granted to them personally — shown in orange below.'
              : ' Nothing has been granted to them personally.'}
          </p>

          {exceptions.length ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 26 }}>
                <span className="ws-lbl">Personal exceptions</span>
                <DataNote source="overrideRemoval" />
              </div>
              <div className="ws-rows" style={{ marginTop: 6 }}>
                {exceptions.map(({ tool, state }) => (
                  <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={`${tool.tool.toolId}:${state.actionGroup}`}>
                    <div className="ws-row-main">
                      <b style={{ fontWeight: 400 }}>
                        {state.storedOverride ? 'Can ' : 'Cannot '}
                        {tool.actionLabels[state.actionGroup] ?? `${state.actionGroup} ${tool.tool.name}`}
                      </b>
                      <p>
                        Granted directly, outside the {person.roleName ?? 'Member'} role — so it wins even if the role changes
                        {state.effectiveBlockReason ? `. ${BLOCK_NOTE[state.effectiveBlockReason]}, so it is having no effect.` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      title="Drops the exception so they follow the role again."
                      onClick={() => void lift(tool.tool.toolId, state.actionGroup)}
                    >
                      Use role instead
                    </button>
                  </div>
                ))}
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
                  <button type="button" className="btn" onClick={() => setCopyFrom(true)}>Choose</button>
                </div>
              </div>
            </>
          ) : null}

          {copyFrom ? (
            <div className="ws-panel" style={{ marginTop: 16 }}>
              <header><div className="ws-panel-t"><h2>Match whose access?</h2></div></header>
              <div className="ws-rows">
                {people.filter((p) => p.userId !== userId && p.roleSlug !== 'MANAGER').map((p) => (
                  <div className="ws-row click" key={p.userId} onClick={() => applyCopy(p.userId)}>
                    <span className="avatar">{initialsOf(p.name, p.email)}</span>
                    <div className="ws-row-main"><b>{displayName(p.name, p.email)}</b><p>{p.roleName ?? 'Member'}</p></div>
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
              Locked cells are held down by <b>company policy</b>, above your level. The backend clamps a team grant to
              the company ceiling, so turning one on here would change nothing.
            </div>
          </div>
          <ToolMatrix tools={matrix.tools} cellFor={cellFor} onToggle={isManager ? undefined : toggle} readOnly={isManager} />
        </>
      )}

      {pending.length > 0 ? (
        <div className="ws-diff" style={{ marginTop: 22 }}>
          <div className="ws-diff-h">
            {pending.length} change{pending.length > 1 ? 's' : ''} for {firstName(person.name, person.email)}, not saved yet
          </div>
          <div className="ws-diff-l">
            {pending.map((c) => {
              const tool = matrix.tools.find((t) => t.tool.toolId === c.toolId)
              return (
                <div className="ws-diff-i" key={`${c.toolId}:${c.action}`} data-k={c.next ? 'add' : 'remove'}>
                  <span className="sg">{c.next ? '+' : '−'}</span>
                  <span>
                    {c.next ? 'Can' : 'Can no longer'} <b>{tool?.actionLabels[c.action] ?? `${c.action} ${tool?.tool.name}`}</b>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="ws-diff-f">
            <button type="button" className="btn" onClick={() => setPending([])} disabled={saving}>Discard</button>
            <button type="button" className="btn primary" onClick={() => void apply()} disabled={saving}>
              {saving ? 'Saving…' : `Apply ${pending.length}`}
            </button>
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}

const stateOfUser = (tool: ToolScopeSnapshot, userId: string, action: string) =>
  tool.memberActionStates.find((s) => s.userId === userId && s.actionGroup === action)

/* ══ Roles ═════════════════════════════════════════════ */
export function TeamRoles({ replay, toast }: Props) {
  const dept = useMyManagedDepartment()
  const [r1] = useStaged([300], replay)
  const { snapshot } = useDepartment(dept?.id)
  const matrix = useDepartmentMatrix(dept?.id)
  const [roleId, setRoleId] = useState<string | null>(null)
  const [pending, setPending] = useState<{ toolId: string; action: string; next: boolean }[]>([])
  const [saving, setSaving] = useState(false)

  if (!dept) return <NoTeam />

  const roles = snapshot?.roles ?? []
  // Managers are governed at the company level, so editing that role here would
  // promise something this scope cannot deliver.
  const editable = roles.filter((r) => r.slug !== 'MANAGER')
  const selected = editable.find((r) => r.id === roleId) ?? editable[0]
  const holders = (snapshot?.memberships ?? []).filter((m) => m.roleId === selected?.id)

  const roleState = (tool: ToolScopeSnapshot, action: string) =>
    tool.roleActionStates.find((s) => s.roleId === selected?.id && s.actionGroup === action)

  const cellFor = (tool: ToolScopeSnapshot, action: string): Cell => {
    const cell = cellFromRole(roleState(tool, action))
    const edit = pending.find((c) => c.toolId === tool.tool.toolId && c.action === action)
    return edit ? { ...cell, on: edit.next, source: 'department_role' } : cell
  }

  const toggle = (tool: ToolScopeSnapshot, action: string, cell: Cell) => {
    if (cell.blocked) return
    const configured = Boolean(roleState(tool, action)?.configuredAllowed)
    setPending((prev) => {
      const without = prev.filter((c) => !(c.toolId === tool.tool.toolId && c.action === action))
      const next = !cell.on
      return configured === next ? without : [...without, { toolId: tool.tool.toolId, action, next }]
    })
  }

  const apply = async () => {
    if (!selected) return
    setSaving(true)
    try {
      for (const change of pending) {
        await matrix.setRoleAction(change.toolId, selected.id, change.action, change.next)
      }
      toast(`Role updated for ${holders.length} ${holders.length === 1 ? 'person' : 'people'}`)
      setPending([])
    } catch {
      toast('Could not save every change — reopen to see what landed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={dept.name}
        title="Roles"
        description="A role is a starting point, not a cage. Change one here and it changes for everyone who holds it."
        actions={<button type="button" className="btn" onClick={() => toast('New roles are created from the company scope')}><Plus size={14} />New role</button>}
      />
      {editable.length > 1 ? (
        <div className="filters">
          <Seg
            value={selected?.id ?? ''}
            onChange={(v) => { setRoleId(v); setPending([]) }}
            options={editable.map((r) => ({
              value: r.id,
              label: `${r.name} (${(snapshot?.memberships ?? []).filter((m) => m.roleId === r.id).length})`,
            }))}
          />
        </div>
      ) : null}

      <div className="ws-stack">
        {pending.length > 0 && selected ? (
          <div className="ws-diff">
            <div className="ws-diff-h">
              <TriangleAlert size={14} style={{ color: 'var(--ws-warning)' }} />
              This changes access for {holders.length} {holders.length === 1 ? 'person' : 'people'} at once
            </div>
            <div className="ws-diff-l">
              {pending.map((c) => {
                const tool = matrix.tools.find((t) => t.tool.toolId === c.toolId)
                return (
                  <div className="ws-diff-i" key={`${c.toolId}:${c.action}`} data-k={c.next ? 'add' : 'remove'}>
                    <span className="sg">{c.next ? '+' : '−'}</span>
                    <span>{c.next ? 'Can' : 'Can no longer'} <b>{tool?.actionLabels[c.action] ?? `${c.action} ${tool?.tool.name}`}</b></span>
                    <small>{holders.map((h) => firstName(h.name, h.email)).join(', ')}</small>
                  </div>
                )
              })}
            </div>
            <div className="ws-diff-f">
              <button type="button" className="btn" onClick={() => setPending([])} disabled={saving}>Discard</button>
              <button type="button" className="btn primary" onClick={() => void apply()} disabled={saving}>
                {saving ? 'Saving…' : `Apply to ${holders.length}`}
              </button>
            </div>
          </div>
        ) : null}

        <Panel
          title={selected?.name ?? 'Roles'}
          description={holders.length
            ? `${holders.length} people · ${holders.map((h) => firstName(h.name, h.email)).join(', ')}`
            : 'Nobody holds this role yet'}
          source="permissions"
        >
          <div className="ws-panel-body">
            {!r1 || matrix.loading ? <SkelRows n={6} icon={false} /> : !selected ? (
              <Empty title="No editable roles" body="Every role in this team is governed at company level." />
            ) : (
              <Fade><ToolMatrix tools={matrix.tools} cellFor={cellFor} onToggle={toggle} /></Fade>
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
  const dept = useMyManagedDepartment()
  const [r1] = useStaged([280], replay)
  const matrix = useDepartmentMatrix(dept?.id)
  const { policy, loading, saving, save } = useApprovalPolicy(dept?.id)

  if (!dept) return <NoTeam />

  const gated = new Set(
    (policy?.requiredActions ?? []).flatMap((entry) => entry.actions.map((a) => `${entry.toolId}:${a}`)),
  )
  // Reading is never gated: an approval prompt on every lookup would train
  // people to approve without reading, which is worse than no gate at all.
  const gateable = matrix.tools.flatMap((tool) =>
    tool.supportedActions.filter((a) => a !== 'read').map((action) => ({ key: `${tool.tool.toolId}:${action}`, tool, action })),
  )

  /** The route replaces the policy wholesale, so send the complete next state. */
  const commit = async (next: Set<string>, enabled: boolean) => {
    const byTool = new Map<string, string[]>()
    for (const key of next) {
      const [toolId, action] = key.split(':') as [string, string]
      byTool.set(toolId, [...(byTool.get(toolId) ?? []), action])
    }
    try {
      await save({ enabled, requiredActions: [...byTool].map(([toolId, actions]) => ({ toolId, actions })) })
      toast('Approval policy updated')
    } catch {
      toast('Could not update the approval policy')
    }
  }

  const toggle = (key: string) => {
    const next = new Set(gated)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    void commit(next, policy?.enabled ?? true)
  }

  return (
    <>
      <PageHeader
        eyebrow={dept.name}
        title="What Divo must ask you first"
        description="Anything ticked here pauses and waits for your approval before it happens. Reading is never gated."
      />
      <div className="ws-stack">
        <Panel>
          <div className="ws-panel-body" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Ask me before risky actions</div>
              <p className="ws-sub" style={{ marginTop: 4, lineHeight: 1.5 }}>
                When off, Divo acts immediately for everyone in {dept.name}, within whatever their role allows.
              </p>
            </div>
            <Switch
              on={policy?.enabled ?? false}
              onToggle={() => void commit(gated, !(policy?.enabled ?? false))}
              label="Approvals"
            />
          </div>
        </Panel>

        {policy?.enabled ? (
          <Panel title="Gated actions" description={`${gated.size} of ${gateable.length} actions need you`} source="permissions">
            {!r1 || loading || matrix.loading ? <SkelRows n={5} icon={false} /> : (
              <Fade>
                <div className="ws-rows">
                  {gateable.map(({ key, tool, action }) => (
                    <div className="ws-row" key={key}>
                      <div className="ws-row-main">
                        <b style={{ fontWeight: 400 }}>{tool.actionLabels[action] ?? `${action} ${tool.tool.name}`}</b>
                        <p>{tool.tool.name} · {action}</p>
                      </div>
                      <Switch on={gated.has(key)} onToggle={() => !saving && toggle(key)} label={key} />
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
  const dept = useMyManagedDepartment()
  const [r1] = useStaged([320], replay)
  const { usage, loading } = useTeamUsage(dept?.id)

  if (!dept) return <NoTeam />

  const top = usage.people[0]

  return (
    <>
      <PageHeader eyebrow={dept.name} title="Team usage" description="What Divo did for your team, and what it cost." />
      <div className="ws-stack">
        <div className="ws-cols">
          <Panel title="Cost by person" source="teamUsage">
            {!r1 || loading ? <SkelRows n={5} icon={false} /> : usage.people.length === 0 ? (
              <Empty title="Nobody in this team yet" body="Add someone and their usage will appear here." />
            ) : (
              <Fade>
                <div className="ws-panel-body">
                  {usage.people.map((p) => (
                    <div key={p.userId} style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7, fontSize: 13 }}>
                        <span>{displayName(p.name, p.email)}</span>
                        <span className="ws-sub">{money(p.spendUsd)} · {p.runs} tasks</span>
                      </div>
                      <Bar
                        pct={usage.spendUsd > 0 ? (p.spendUsd / usage.spendUsd) * 100 : 0}
                        tone={top && p.userId === top.userId && p.spendUsd > 0 ? 'brand' : undefined}
                      />
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </Panel>

          <Panel title="Summary" source="teamUsage">
            <div className="ws-panel-body">
              {!r1 || loading ? <Skel w="100%" h={120} /> : (
                <Fade>
                  <div className="ws-lbl">{usage.days}-day cost</div>
                  <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(usage.spendUsd)}</div>
                  <div style={{ marginTop: 22 }}>
                    <div className="kv"><span className="k">Tasks</span><span className="v">{usage.runs}</span></div>
                    <div className="kv"><span className="k">Using Divo</span><span className="v">{usage.activePeople} of {usage.totalPeople}</span></div>
                    <div className="kv">
                      <span className="k">Highest</span>
                      <span className="v">{top && top.spendUsd > 0 ? displayName(top.name, top.email) : '—'}</span>
                    </div>
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
