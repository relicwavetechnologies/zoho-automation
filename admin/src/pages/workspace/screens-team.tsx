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
import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight, Check, Clock, Copy, Lock, Plus, Search, ShieldCheck,
  Trash2, TriangleAlert, UserPlus, Users,
} from 'lucide-react'
import {
  Bar, ClickRow, Confirm, DataNote, Drawer, Empty, Fade, NoAccess, PageHeader, Panel, Prompt, Seg, Skel, SkelRows,
  Switch, listPhrase, money, useStaged,
} from './ui'
import type { Toast } from './ui'
import {
  candidateBlock, candidateLabel,
  useApprovalPolicy, useDepartment, useDepartmentMatrix, useManagedDepartments, useTeamUsage,
  type Candidate, type DeptRole, type MemberActionState, type RoleActionState, type ToolScopeSnapshot,
} from './data/use-team'
import { useApprovals, expiryLabel } from './data/use-approvals'

type Props = { replay: number; toast: Toast; go: (screen: string) => void }

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

/**
 * Which of your teams this screen is about.
 *
 * Only rendered by somebody who leads more than one. For everybody else the
 * eyebrow already names their department and a one-option switch would be a
 * control that cannot do anything.
 *
 * It sits under the header on every Team screen rather than only on the
 * overview, because the answer to "whose people am I looking at" has to be on
 * screen wherever you landed — including from a bookmark straight into Roles.
 */
function TeamSwitch() {
  const { departments, department, select } = useManagedDepartments()
  if (departments.length < 2 || !department) return null
  return (
    <div className="filters">
      <Seg
        value={department.id}
        onChange={select}
        options={departments.map((d) => ({ value: d.id, label: d.name }))}
      />
      <span className="ws-sub">You lead {departments.length} teams — everything below is about this one</span>
    </div>
  )
}

/** The department the Team scope is about, for screens that only need the one. */
const useMyManagedDepartment = () => useManagedDepartments().department

/* ══ Team overview ═════════════════════════════════════ */
export function TeamHome({ replay, go }: Props) {
  const dept = useMyManagedDepartment()
  const [r1, r2] = useStaged([260, 560], replay)
  const { snapshot, loading, refused } = useDepartment(dept?.id)
  const { usage } = useTeamUsage(dept?.id)
  const { coverage } = useDepartmentMatrix(dept?.id)
  const { awaitingMe } = useApprovals()

  if (!dept) return <NoTeam />
  // Being removed as manager mid-session is the case this catches: the scope
  // switcher still shows the team until the session refreshes.
  if (refused) return <NoAccess what="this team" who="You no longer lead this department. Whoever holds the Manager role in it can see this." />

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
      <TeamSwitch />
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
                      <ClickRow key={p.userId} onOpen={() => go('people')}>
                        <span className="avatar">{initialsOf(p.name, p.email)}</span>
                        <div className="ws-row-main">
                          <b>{displayName(p.name, p.email)}</b>
                          <p>{p.roleName ?? 'Member'}{spend && spend.runs === 0 ? ' · never used Divo' : ''}</p>
                        </div>
                        <span className="ws-sub">{spend?.runs ?? 0} tasks</span>
                      </ClickRow>
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
  const {
    snapshot, loading, error, refused, addMember, removeMember, setMemberRole, findCandidates, refresh,
  } = useDepartment(dept?.id)
  const { usage } = useTeamUsage(dept?.id)
  const matrix = useDepartmentMatrix(dept?.id)
  const [adding, setAdding] = useState(false)

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
        actions={<button type="button" className="btn primary" onClick={() => setAdding(true)}><UserPlus size={14} />Add someone</button>}
      />
      <TeamSwitch />
      <div className="filters">
        <div className="search" style={{ maxWidth: 300 }}>
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find someone"
          />
        </div>
      </div>

      <Panel source="teamPeople">
        {/* "Nobody matches" is an answer about the search box. A refused or
            failed snapshot produces the same empty list with an empty search
            box, which reads as an empty team — so both are named first. */}
        {!r1 || loading ? <SkelRows n={6} /> : refused ? (
          <NoAccess
            what="this team's people"
            who="Only whoever leads this team can see who is in it."
          />
        ) : error ? (
          <Empty
            icon={TriangleAlert}
            title="Could not load this team"
            body={error}
            action={<button type="button" className="btn" onClick={() => void refresh()}>Try again</button>}
          />
        ) : list.length === 0 ? (
          <Empty
            icon={Users}
            title={people.length === 0 ? 'Nobody is in this team yet' : 'Nobody matches'}
            body={people.length === 0 ? 'Add someone to give Divo a team to work for.' : 'Try a different name.'}
          />
        ) : (
          <Fade>
            <div className="ws-rows">
              {list.map((p) => {
                const count = exceptionsFor(p.userId)
                const spend = spendByUser.get(p.userId)
                return (
                  <ClickRow key={p.userId} onOpen={() => setOpen(p.userId)}>
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
                  </ClickRow>
                )
              })}
            </div>
          </Fade>
        )}
      </Panel>

      {adding ? (
        <AddPersonDrawer
          roles={snapshot?.roles ?? []}
          search={findCandidates}
          onAdd={async (userId, roleId, name) => {
            try { await addMember(userId, roleId); toast(`${name} added`) }
            catch { toast('Could not add them', 'error') }
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {open ? (
        <PersonDrawer
          userId={open}
          onClose={() => setOpen(null)}
          toast={toast}
          matrix={matrix}
          people={people}
          departmentName={dept.name}
          roles={snapshot?.roles ?? []}
          onSetRole={async (userId, roleId, roleName, who) => {
            try { await setMemberRole(userId, roleId); toast(`${who} is now ${roleName}`) }
            catch { toast('Could not change their role', 'error') }
          }}
          onRemove={async (userId, who) => {
            try { await removeMember(userId); toast(`${who} removed from ${dept.name}`); setOpen(null) }
            catch (e) { toast(e instanceof Error ? e.message : 'Could not remove them', 'error') }
          }}
        />
      ) : null}
    </>
  )
}

/**
 * Adding somebody to the team.
 *
 * The search is server-side and returns everyone it matched, including people
 * already in this team and Lark accounts with no Divo user behind them. Those
 * rows are shown but not selectable, with the reason on the row: a list that
 * offers a name and then rejects it is worse than no list, and a list that
 * silently omits somebody you can see in Lark is just as confusing.
 *
 * A role is required rather than defaulted, because "which role" is the whole
 * decision and silently picking one hides it.
 */
function AddPersonDrawer({ roles, search, onAdd, onClose }: {
  roles: { id: string; name: string }[]
  search: (query: string) => Promise<Candidate[]>
  onAdd: (userId: string, roleId: string, name: string) => Promise<void>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Candidate[]>([])
  const [picked, setPicked] = useState<Candidate | null>(null)
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    let live = true
    // Debounced: this hits the backend on every keystroke otherwise, and the
    // route searches the whole company directory.
    const timer = setTimeout(() => { void search(query).then((r) => { if (live) setResults(r) }) }, 220)
    return () => { live = false; clearTimeout(timer) }
  }, [query, search])

  return (
    <Drawer
      title="Add someone"
      subtitle="They keep their company role — this decides what Divo may do for them in this team"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!picked?.userId || !roleId || busy}
            onClick={async () => {
              if (!picked?.userId || !roleId) return
              setBusy(true)
              try { await onAdd(picked.userId, roleId, candidateLabel(picked)); onClose() }
              finally { setBusy(false) }
            }}
          >
            {busy ? 'Adding…' : 'Add to team'}
          </button>
        </>
      }
    >
      <div className="ws-lbl">Who</div>
      <div className="search" style={{ marginTop: 8 }}>
        <Search size={14} />
        <input
          autoFocus
          value={picked ? candidateLabel(picked) : query}
          onChange={(e) => { setPicked(null); setQuery(e.target.value) }}
          placeholder="Search by name or email"
        />
      </div>

      {!picked && query.trim().length >= 2 ? (
        <div className="ws-rows" style={{ marginTop: 10 }}>
          {results.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Empty title="Nobody matches" body="They may already be in this team, or not in the company yet." />
            </div>
          ) : results.map((r) => {
            const blocked = candidateBlock(r)
            const label = candidateLabel(r)
            return (
              <div
                className={blocked ? 'ws-row' : 'ws-row click'}
                key={r.channelIdentityId}
                data-muted={blocked ? '' : undefined}
                onClick={blocked ? undefined : () => setPicked(r)}
              >
                <span className="avatar">{initialsOf(r.name ?? r.larkDisplayName ?? null, r.email ?? '')}</span>
                <div className="ws-row-main">
                  <b>{label}</b>
                  <p>{r.email ?? 'No email on their Lark account'}</p>
                </div>
                {blocked ? <span className="ws-sub">{blocked}</span> : null}
              </div>
            )
          })}
        </div>
      ) : null}

      {picked ? (
        <>
          <div className="ws-lbl" style={{ marginTop: 22 }}>Role in this team</div>
          <select className="select" style={{ width: '100%', marginTop: 8 }} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <p className="ws-sentence-note">
            Whatever this role grants applies to them immediately. Nothing is granted personally.
          </p>
        </>
      ) : null}
    </Drawer>
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
function PersonDrawer({
  userId, onClose, toast, matrix, people, roles, departmentName, onSetRole, onRemove,
}: {
  userId: string
  onClose: () => void
  toast: Toast
  matrix: ReturnType<typeof useDepartmentMatrix>
  people: { userId: string; name: string | null; email: string; roleId?: string; roleSlug?: string; roleName?: string }[]
  roles: DeptRole[]
  departmentName: string
  onSetRole: (userId: string, roleId: string, roleName: string, who: string) => Promise<void>
  onRemove: (userId: string, who: string) => Promise<void>
}) {
  const person = people.find((p) => p.userId === userId)
  const [tab, setTab] = useState<'summary' | 'detail'>('summary')
  const [pending, setPending] = useState<{ toolId: string; action: string; next: boolean }[]>([])
  const [copyFrom, setCopyFrom] = useState(false)
  const [saving, setSaving] = useState(false)
  const [movingTo, setMovingTo] = useState<DeptRole | null>(null)
  const [removing, setRemoving] = useState(false)

  if (!person) return null
  const isManager = person.roleSlug === 'MANAGER'
  // Managers are governed at company level, so offering to move somebody into
  // the Manager role here would promise something this scope cannot deliver.
  const assignableRoles = roles.filter((r) => r.slug !== 'MANAGER')
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
      toast('Could not save every change — reopen to see what landed', 'error')
    } finally {
      setSaving(false)
    }
  }

  const lift = async (toolId: string, action: string) => {
    try {
      await matrix.clearMemberAction(toolId, userId, action)
      toast('Exception removed — they follow the role again')
    } catch {
      toast('Could not remove that exception', 'error')
    }
  }

  return (
    <>
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

      {/* Every sentence and every cell in this drawer is derived from the
          matrix. Without it, "Divo cannot do anything for them yet" is not a
          fact about this person — it is the shape of a failed read. */}
      {matrix.loading ? <SkelRows n={5} icon={false} /> : matrix.error ? (
        <Empty
          icon={TriangleAlert}
          title="Could not read their permissions"
          body={matrix.error}
          action={<button type="button" className="btn" onClick={() => void matrix.refresh()}>Try again</button>}
        />
      ) : tab === 'summary' ? (
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
                  <ClickRow key={p.userId} onOpen={() => applyCopy(p.userId)}>
                    <span className="avatar">{initialsOf(p.name, p.email)}</span>
                    <div className="ws-row-main"><b>{displayName(p.name, p.email)}</b><p>{p.roleName ?? 'Member'}</p></div>
                    <ArrowRight size={14} className="muted" />
                  </ClickRow>
                ))}
              </div>
            </div>
          ) : null}

          {/* Last, and deliberately so. Everything above adjusts what Divo may
              do for somebody who is in the team; this is whether they are in it
              at all, and the destructive half of it belongs at the bottom of a
              drawer rather than next to the first thing you read. */}
          {!isManager ? (
            <>
              <div className="ws-lbl" style={{ marginTop: 26 }}>Membership</div>
              <div className="ws-rows" style={{ marginTop: 6 }}>
                <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <div className="ws-row-main">
                    <b>Role in {departmentName}</b>
                    <p>A role is the starting point for everything Divo may do for them here.</p>
                  </div>
                  <select
                    className="select"
                    aria-label={`Role for ${person.email}`}
                    value={person.roleId ?? ''}
                    onChange={(e) => {
                      const next = assignableRoles.find((r) => r.id === e.target.value)
                      if (next && next.id !== person.roleId) setMovingTo(next)
                    }}
                  >
                    {assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <div className="ws-row-main">
                    <b>Remove from this team</b>
                    <p>Their Divo account and any other team they are in are untouched.</p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    style={{ color: 'var(--cur-error)', borderColor: 'var(--cur-error)' }}
                    onClick={() => setRemoving(true)}
                  >
                    <Trash2 size={14} />Remove
                  </button>
                </div>
              </div>
            </>
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

      {/* Siblings of the drawer, not children. The drawer is a fixed element
          with its own stacking context, so a dialog nested inside it can never
          paint above it — and during the open animation its transform would
          make the "fixed" dialog position against the drawer instead of the
          viewport. */}
      {movingTo ? (
        <Confirm
          title={`Move ${firstName(person.name, person.email)} to ${movingTo.name}?`}
          body={`They stop getting whatever ${person.roleName ?? 'their current role'} grants and start getting whatever ${movingTo.name} grants.${
            exceptions.length
              ? ` Their ${exceptions.length} personal exception${exceptions.length > 1 ? 's stay' : ' stays'} in place on top.`
              : ''
          }`}
          confirm="Move them"
          onClose={() => setMovingTo(null)}
          onConfirm={() => onSetRole(userId, movingTo.id, movingTo.name, firstName(person.name, person.email))}
        />
      ) : null}

      {removing ? (
        <Confirm
          title={`Remove ${displayName(person.name, person.email)} from ${departmentName}?`}
          body={`Divo stops doing anything for them through this team, and anything granted to them personally here goes with the membership. Their Divo account, and any other team they are in, are untouched.`}
          confirm="Remove from team"
          onClose={() => setRemoving(false)}
          onConfirm={() => onRemove(userId, displayName(person.name, person.email))}
        />
      ) : null}
    </>
  )
}

const stateOfUser = (tool: ToolScopeSnapshot, userId: string, action: string) =>
  tool.memberActionStates.find((s) => s.userId === userId && s.actionGroup === action)

/* ══ Roles ═════════════════════════════════════════════ */
export function TeamRoles({ replay, toast }: Props) {
  const dept = useMyManagedDepartment()
  const [r1] = useStaged([300], replay)
  const { snapshot, createRole, renameRole, deleteRole } = useDepartment(dept?.id)
  const matrix = useDepartmentMatrix(dept?.id)
  const [roleId, setRoleId] = useState<string | null>(null)
  const [creatingRole, setCreatingRole] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
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
      toast('Could not save every change — reopen to see what landed', 'error')
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
        actions={<button type="button" className="btn" onClick={() => setCreatingRole(true)}><Plus size={14} />New role</button>}
      />
      <TeamSwitch />
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
          aside={selected ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setRenaming(true)}>Rename</button>
              {/*
                * Deleting is offered even when it will be refused, and the
                * refusal is shown rather than pre-empted. The backend owns the
                * three rules — a system role, the default role, and a role
                * somebody still holds — and hiding the button would leave a
                * manager with a role they cannot remove and no idea why.
                * Its message names the reason and what to do about it.
                */}
              <button type="button" className="btn" onClick={() => setDeleting(true)}>
                <Trash2 size={14} />Delete
              </button>
            </div>
          ) : undefined}
        >
          <div className="ws-panel-body">
            {!r1 || matrix.loading ? <SkelRows n={6} icon={false} /> : matrix.error ? (
              /* The read failed. Saying "no configurable tools" here would be a
                 claim about the team made on the strength of a broken request. */
              <Empty
                icon={TriangleAlert}
                title="Could not load this team's permissions"
                body={matrix.error}
                action={<button type="button" className="btn" onClick={() => void matrix.refresh()}>Try again</button>}
              />
            ) : !selected ? (
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

      {renaming && selected ? (
        <Prompt
          title="Rename role"
          description="Only the label changes. Everyone keeps the role and everything it grants."
          label="Name"
          initial={selected.name}
          confirm="Rename"
          onClose={() => setRenaming(false)}
          onConfirm={async (name) => {
            try { await renameRole(selected.id, name); toast(`Renamed to ${name}`) }
            catch { toast('Could not rename that role', 'error') }
          }}
        />
      ) : null}

      {deleting && selected ? (
        <Confirm
          title={`Delete ${selected.name}?`}
          body={holders.length
            ? `${holders.length} ${holders.length === 1 ? 'person holds' : 'people hold'} this role. Move them to another role first — the backend will refuse this until you do.`
            : 'Nobody holds this role, so nothing anyone can do changes. The permissions granted to it are removed with it.'}
          confirm="Delete role"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await deleteRole(selected.id)
              setRoleId(null)
              toast(`${selected.name} deleted`)
            } catch (e) {
              // The service refuses with a sentence that already says what to
              // do — "Move members off this role before deleting it" — so it is
              // shown as-is rather than flattened into "could not delete".
              toast(e instanceof Error ? e.message : 'Could not delete that role', 'error')
            }
          }}
        />
      ) : null}

      {creatingRole ? (
        <Prompt
          title="New role"
          description="A role starts with nothing granted. Add people to it and then decide what Divo may do for them."
          label="Name"
          placeholder="Analyst"
          confirm="Create"
          onClose={() => setCreatingRole(false)}
          onConfirm={async (name) => {
            try { await createRole(name); toast(`${name} created`) }
            catch { toast('Could not create that role', 'error') }
          }}
        />
      ) : null}
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
    // Every write replaces the whole policy, so committing before the current
    // one is known would overwrite it with whatever the empty default is.
    if (!policy) { toast('The approval policy has not loaded yet'); return }
    const byTool = new Map<string, string[]>()
    for (const key of next) {
      const [toolId, action] = key.split(':') as [string, string]
      byTool.set(toolId, [...(byTool.get(toolId) ?? []), action])
    }
    try {
      await save({ enabled, requiredActions: [...byTool].map(([toolId, actions]) => ({ toolId, actions })) })
      toast('Approval policy updated')
    } catch {
      toast('Could not update the approval policy', 'error')
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
      <TeamSwitch />
      <div className="ws-stack">
        <Panel>
          <div className="ws-panel-body" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Ask me before risky actions</div>
              <p className="ws-sub" style={{ marginTop: 4, lineHeight: 1.5 }}>
                When off, Divo acts immediately for everyone in {dept.name}, within whatever their role allows.
              </p>
            </div>
            {/* Held back until the policy has actually loaded. `gated` is derived
                from it, so toggling against a null policy would send an empty
                requiredActions and silently delete every gate in the team. */}
            {loading ? <Skel w={38} h={22} /> : policy === null ? (
              <span className="ws-sub">Could not read the policy</span>
            ) : (
              <Switch
                on={policy.enabled}
                onToggle={() => void commit(gated, !policy.enabled)}
                label="Approvals"
              />
            )}
          </div>
        </Panel>

        {loading || policy === null ? (
          // Not an else-branch of `enabled`. "Nothing is gated" is a safety
          // claim, and a null policy means the read failed or has not landed —
          // telling a manager their team has no approval gates, from no
          // evidence, points them exactly the wrong way.
          <Panel><div className="ws-panel-body">{loading ? <SkelRows n={3} icon={false} /> : (
            <span className="ws-sub">Whether anything needs your approval could not be read, so it is not stated here.</span>
          )}</div></Panel>
        ) : policy.enabled ? (
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
      <TeamSwitch />
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
