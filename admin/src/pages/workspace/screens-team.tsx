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
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight, Check, ChevronDown, Clock, Copy, Lock, Plus, Search, ShieldCheck,
  Trash2, TriangleAlert, UserPlus, Users,
} from 'lucide-react'
import {
  Bar, ClickRow, Confirm, DataNote, Drawer, Empty, Fade, NoAccess, PageHeader, Panel, Prompt,
  RowMenu, Seg, Skel, SkelRows, Switch, ToolMark, TrendChart, listPhrase, money, useStaged,
} from './ui'
import type { Toast } from './ui'
import { notify } from '@/lib/notify'
import {
  candidateBlock, candidateLabel,
  useApprovalPolicy, useDepartment, useDepartmentMatrix, useManagedDepartments, useTeamUsage,
  type Candidate, type DeptRole, type MemberActionState, type RoleActionState, type ToolScopeSnapshot,
} from './data/use-team'
import { dayLabel, summarizeSpend, USAGE_DAYS, USAGE_WEEKS } from './data/use-my-activity'
import { useDecisions } from './data/use-decisions'
import { expiryLabel } from './decisions/decision'

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
/**
 * The matrix's own skeleton.
 *
 * This screen fetches one request per tool — around thirty-five, each with its
 * own preflight — so the placeholder is on screen for several seconds rather
 * than a blink, and it was five flat rows standing in for a thirty-five row
 * table. The page grew by most of its own height when the real thing landed.
 *
 * The row count is the number the registry actually returns, so the table does
 * not jump; the columns are the six action groups every scope shows.
 */
const MATRIX_SKELETON_ROWS = 35
const MATRIX_SKELETON_COLS = 6

/*
 * 56px, which is the mean real row and not a guess.
 *
 * Measured across the live table: rows come in at 45, 48, 50, 58 and 78 —
 * mostly 58, with two that wrap because their names are long. A uniform 49
 * undershot the total by 252px over thirty-five rows, so the page still grew by
 * most of a screen when the data landed. There is no single height that is
 * right for every row; the mean is the one that makes the *table* the right
 * height, which is what stops the reflow.
 */
const MATRIX_SKELETON_ROW_H = 56

function ToolMatrixSkeleton() {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="ws-matrix is-skeleton">
        <thead>
          <tr>
            <th><Skel w={44} h={9} /></th>
            {Array.from({ length: MATRIX_SKELETON_COLS }).map((_, i) => (
              <th key={i} className="act"><Skel w={46} h={9} /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: MATRIX_SKELETON_ROWS }).map((_, r) => (
            <tr key={r} style={{ height: MATRIX_SKELETON_ROW_H }}>
              <td>
                <span className="ws-mx-tool">
                  <span className="ws-toolmark"><Skel w={24} h={24} block /></span>
                  <Skel w={92 + ((r * 13) % 58)} h={11} />
                </span>
              </td>
              {/* 26px is the exact size of `.ws-cell` — measured, not guessed:
                  at 22 the table came up 252px short across thirty-five rows. */}
              {Array.from({ length: MATRIX_SKELETON_COLS }).map((_, c) => (
                <td key={c} className="act"><Skel w={26} h={26} block /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

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
              <td>
                {/* The app's mark beside its name, so "the Google ones" is a
                    glance rather than fifteen lines of reading. */}
                <span className="ws-mx-tool">
                  <ToolMark toolName={tool.tool.name} />
                  <span style={{ fontWeight: 500 }}>{tool.tool.name}</span>
                </span>
              </td>
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
  // `loading` was dropped on the floor and the panel gated on the staged timer
  // instead, so "Team cost $0.00 · 0 tasks" appeared at 560ms whether or not
  // the figure had arrived — a zero that means "not yet" reads exactly like a
  // zero that means "nobody spent anything".
  const { usage, loading: usageLoading } = useTeamUsage(dept?.id)
  const { coverage } = useDepartmentMatrix(dept?.id)
  const { awaitingMe } = useDecisions()

  if (!dept) return <NoTeam />
  // Being removed as manager mid-session is the case this catches: the scope
  // switcher still shows the team until the session refreshes.
  if (refused) return <NoAccess what="this team" who="You no longer lead this department. Whoever holds the Manager role in it can see this." />

  const people = snapshot?.memberships ?? []
  const spendByUser = new Map(usage.people.map((p) => [p.userId, p]))
  const idle = usage.people.filter((p) => p.runs === 0)
  const exceptions = coverage?.tools.reduce((n, t) => n + t.exceptionCount, 0) ?? 0

  const attention = [
    ...awaitingMe.map((decision) => ({
      tone: 'act' as const,
      title: decision.title,
      body: `${decision.source} is waiting. ${decision.detail ?? ''}`.trim(),
      meta: [expiryLabel(decision.expiresAt)?.text].filter((m): m is string => Boolean(m)),
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
        /*
         * The count waits for the count.
         *
         * `people` is an empty array until the snapshot lands, and rendering
         * its length regardless put "0 people" at the top of the page while the
         * panel below it was still honestly showing skeletons — the header
         * asserting a number the page did not have yet, and the worst possible
         * one for a manager to read about their own team.
         */
        description={loading
          ? 'You decide what Divo may do for each of them, and what it must ask you first.'
          : `${people.length} ${people.length === 1 ? 'person' : 'people'}. You decide what Divo may do for each of them, and what it must ask you first.`}
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
              {!r2 || usageLoading ? <Skel w="100%" h={90} /> : (
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

/**
 * The people list's own skeleton.
 *
 * `SkelRows` ends every row with one 58px block, and this list now ends with
 * four columns totalling 318px — tasks, cost, the role control and the menu. So
 * the placeholder was right about the left of the row and wrong about the right
 * of it, and the whole column slid on arrival.
 */
function PeopleSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="ws-rows">
      {/* 71px is the real row, measured — `.ws-skel-row` comes out at 60 on its
          own padding, and eight of those left the list 80px short before the
          row count even came into it. */}
      {Array.from({ length: n }).map((_, i) => (
        <div className="ws-skel-row" key={i} style={{ minHeight: 71, boxSizing: 'border-box' }}>
          <Skel w={32} h={32} circle />
          <div style={{ flex: 1 }}>
            <Skel w={`${38 + ((i * 13) % 26)}%`} />
            <div style={{ height: 7 }} />
            <Skel w={`${46 + ((i * 17) % 24)}%`} h={9} />
          </div>
          <div className="ws-row-act ws-people-act">
            <Skel w={54} h={11} />
            <Skel w={40} h={11} />
            <Skel w={92} h={28} block />
            <span />
          </div>
        </div>
      ))}
    </div>
  )
}

/** One row of the people list, as the department snapshot carries it. */
type TeamPerson = {
  userId: string
  name: string | null
  email: string
  roleId?: string
  roleSlug?: string
  roleName?: string
}

/**
 * Somebody's role, changeable where you read it.
 *
 * A select rather than a menu, because the choice is one of a short known list
 * and a select says so without being opened. It stops propagation: the row
 * behind it opens the person, and picking a role is not that.
 *
 * A manager's is rendered as text, not a disabled select. A disabled control
 * invites a click that will never work, and this scope genuinely cannot change
 * it — the backend's `ordinaryMember` refuses, so offering the shape of a
 * control would be a promise the product does not keep.
 */
function RoleSelect({ person, roles, busy, onPick }: {
  person: TeamPerson
  roles: DeptRole[]
  busy: boolean
  onPick: (roleId: string, roleName: string) => void
}) {
  if (person.roleSlug === 'MANAGER') {
    return (
      // Padded to sit on the same left edge as the pickers below it — the text
      // and the control occupy one column, so the list has one right margin.
      <span className="ws-role-fixed" title="Only a company admin can change who leads this team">
        {person.roleName ?? 'Manager'}
      </span>
    )
  }
  // Managers are governed at company level, so the Manager role is not on offer
  // here — the same rule the drawer and the roles page already apply.
  const assignable = roles.filter((r) => r.slug !== 'MANAGER')
  if (assignable.length === 0) {
    return <span className="ws-role-fixed">{person.roleName ?? 'Member'}</span>
  }
  return (
    <RolePicker
      current={person.roleName ?? 'Member'}
      currentId={person.roleId}
      options={assignable}
      busy={busy}
      label={`Role for ${displayName(person.name, person.email)}`}
      onPick={onPick}
    />
  )
}

/**
 * A role picker Divo can actually style.
 *
 * This was a native `<select>`, and a native select's *popup* is drawn by the
 * operating system — on macOS that is a blue-highlighted list that owes nothing
 * to the app's palette, sitting on a dark page. The closed control matched and
 * the open one did not, which is the one moment somebody is looking straight at
 * it.
 *
 * Same behaviour as the row menu beside it, and the same dismissal rules, so
 * two adjacent controls on one row do not open in two different ways.
 */
function RolePicker({ current, currentId, options, busy, label, onPick }: {
  current: string
  currentId?: string
  options: DeptRole[]
  busy: boolean
  label: string
  onPick: (roleId: string, roleName: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="ws-menu-wrap" ref={wrap} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="ws-role-pick"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? 'Saving…' : current}
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="ws-menu" role="menu">
          {options.map((r) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={r.id === currentId}
              key={r.id}
              onClick={() => {
                setOpen(false)
                if (r.id !== currentId) onPick(r.id, r.name)
              }}
            >
              {/* The tick holds its column whether or not it is drawn, so the
                  labels do not shift by 19px as the selection moves. */}
              <Check size={13} style={{ opacity: r.id === currentId ? 1 : 0 }} />
              {r.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
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
  /** Whose row is mid-write, so its two controls cannot be pressed twice. */
  const [busyUser, setBusyUser] = useState<string | null>(null)
  const [removing, setRemoving] = useState<TeamPerson | null>(null)

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

  /*
   * The server's sentence, not a generic one.
   *
   * `setMemberRole` refuses a manager with "Only a company administrator can
   * change a department manager", and refuses a role this scope may not assign
   * — each is a different thing to do next, and a flat "Could not change their
   * role" would throw away the only part anybody can act on.
   */
  const changeRole = async (person: TeamPerson, roleId: string, roleName: string) => {
    const who = firstName(person.name, person.email)
    setBusyUser(person.userId)
    try {
      await setMemberRole(person.userId, roleId)
      toast(`${who} is now ${roleName}`)
    } catch (e) {
      notify.failed(`${who}'s role was not changed`, e instanceof Error ? e.message : null)
    } finally {
      setBusyUser(null)
    }
  }

  const confirmRemove = async (person: TeamPerson) => {
    const who = firstName(person.name, person.email)
    setBusyUser(person.userId)
    try {
      await removeMember(person.userId)
      toast(`${who} removed from ${dept.name}`)
    } catch (e) {
      notify.failed(`${who} was not removed`, e instanceof Error ? e.message : null)
    } finally {
      setBusyUser(null)
      setRemoving(null)
    }
  }

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
        {!r1 || loading ? <PeopleSkeleton /> : refused ? (
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
                      {/* The role has moved to the control on the right, so it
                          is not printed twice on one line. */}
                      <p>{p.email}{spend && spend.runs === 0 ? ' · never used Divo' : ''}</p>
                    </div>
                    {/*
                      A fixed grid, not a flex row.
                      Flexed, a manager's row had no menu and a plain-text role
                      while a member's had a 104px control and a button — so the
                      two kinds of row ended their columns 100px apart and the
                      right-hand edge of the list zig-zagged. Every row now
                      reserves the same four columns whether or not it fills
                      them.
                    */}
                    <div className="ws-row-act ws-people-act">
                      <span className="ws-sub">{spend?.runs ?? 0} tasks</span>
                      <span className="ws-sub">{money(spend?.spendUsd ?? 0)}</span>
                      {/*
                        The role, in the row.
                        Changing somebody's role is the commonest thing done on
                        this page and it was three clicks deep — open the person,
                        find Membership, change it, close. It is one click here,
                        and the row still opens for everything else.
                      */}
                      <RoleSelect
                        person={p}
                        roles={snapshot?.roles ?? []}
                        busy={busyUser === p.userId}
                        onPick={(roleId, roleName) => void changeRole(p, roleId, roleName)}
                      />
                      {/* A manager's membership is the backend's to change —
                          `ordinaryMember` refuses it — so there is no menu, and
                          an empty span holds the column so the rows above and
                          below it still line up. */}
                      {p.roleSlug === 'MANAGER' ? <span /> : (
                        <RowMenu
                          busy={busyUser === p.userId}
                          label={`Actions for ${displayName(p.name, p.email)}`}
                          items={[{
                            label: 'Remove from team',
                            icon: Trash2,
                            danger: true,
                            onSelect: () => setRemoving(p),
                          }]}
                        />
                      )}
                    </div>
                  </ClickRow>
                )
              })}
            </div>
          </Fade>
        )}
      </Panel>

      {/* Asked before it happens, because it is not undoable from here: the
          membership goes and anything granted to them personally in this team
          goes with it. Same words the drawer's own Remove uses. */}
      {removing ? (
        <Confirm
          title={`Remove ${firstName(removing.name, removing.email)} from ${dept.name}?`}
          body="Divo stops doing anything for them through this team, and anything granted to them personally here goes with the membership. Their Divo account, and any other team they are in, are untouched."
          confirm="Remove"
          onConfirm={() => { void confirmRemove(removing) }}
          onClose={() => setRemoving(null)}
        />
      ) : null}

      {adding ? (
        <AddPersonDrawer
          roles={snapshot?.roles ?? []}
          search={findCandidates}
          onAdd={async (userId, roleId, name) => {
            try { await addMember(userId, roleId); toast(`${name} added`) }
            // The server's own sentence: it refuses somebody already in the
            // team, and somebody with no Divo account, for different reasons.
            catch (e) { notify.failed('They were not added', e instanceof Error ? e.message : null) }
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
            catch (e) { notify.failed(`${who}'s role was not changed`, e instanceof Error ? e.message : null) }
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
    /*
     * A press that does nothing at all is indistinguishable from a broken one.
     *
     * This returned in silence, so somebody clicking a locked cell got no
     * movement, no message, and no reason — the explanation lived in a hover
     * title and a banner at the top of the tab. Pressing is how a person asks
     * why, and `blockNote` is already the exact answer.
     */
    if (cell.blocked) {
      notify.refused(
        'Company policy holds this one down',
        `${cell.blockNote ?? 'This action is switched off above your level'}. Turning it on here would change nothing.`,
      )
      return
    }
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
    } catch (e) {
      notify.failed('That exception was not removed', e instanceof Error ? e.message : null)
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
      {matrix.loading ? <ToolMatrixSkeleton /> : matrix.error ? (
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
          {/*
            Two different reasons, and this said the first one for both.

            On a fellow manager every cell is locked because they are a manager
            — `readOnly` below — and the banner still blamed company policy. The
            per-cell tooltip falls through to the plain action name in that case,
            so the wrong sentence here was the only sentence there was.
          */}
          <div className="ws-ceiling" style={{ marginBottom: 16 }}>
            <TriangleAlert size={14} />
            <div>
              {isManager ? (
                <>
                  Nothing here is editable because {firstName(person.name, person.email)} leads this team.
                  A manager&rsquo;s access is set at company level — this is what they currently hold.
                </>
              ) : (
                <>
                  Locked cells are held down by <b>company policy</b>, above your level. The backend clamps a team grant to
                  the company ceiling, so turning one on here would change nothing.
                </>
              )}
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
    // Same silence as the person drawer's, and the same answer — see the note
    // there. A locked cell here reports on everybody currently in the role.
    if (cell.blocked) {
      notify.refused(
        'Company policy holds this one down',
        `${cell.blockNote ?? 'This action is switched off above your level'}. Turning it on here would change nothing.`,
      )
      return
    }
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
            {!r1 || matrix.loading ? <ToolMatrixSkeleton /> : matrix.error ? (
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
            // "Built-in department roles cannot be managed here" is the whole
            // answer, and it was being replaced with a shrug.
            catch (e) { notify.failed('That role was not renamed', e instanceof Error ? e.message : null) }
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
            catch (e) { notify.failed('That role was not created', e instanceof Error ? e.message : null) }
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
    } catch (e) {
      notify.failed('The approval policy was not saved', e instanceof Error ? e.message : null)
    }
  }

  /*
   * Enabled follows the list, because the backend already decides it that way.
   *
   * It stores `enabled && requiredActions.length > 0`, so a policy that is on
   * with nothing ticked cannot exist. Sending `enabled` independently let the
   * UI ask for a state the server would silently rewrite — the save succeeded,
   * the toast said so, and the switch flipped back on the next render.
   */
  const toggle = (key: string) => {
    const next = new Set(gated)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    void commit(next, next.size > 0)
  }

  /**
   * The master switch, which could previously only ever be turned off.
   *
   * Turning it on saved `enabled: true` with an empty list, the server rewrote
   * that to false, and the gated-action list was hidden behind `enabled` — so
   * there was no way to tick the first action and no way to reach the state the
   * switch was offering. Now the list is always readable and this refuses with
   * the reason instead of appearing to work.
   */
  const toggleAll = () => {
    if (!policy) { toast('The approval policy has not loaded yet'); return }
    if (!policy.enabled && gated.size === 0) {
      notify.refused(
        'Choose what needs asking first',
        'An approval policy with nothing in it is the same as no policy, so Divo will not store one. Tick an action below and this switches on by itself.',
      )
      return
    }
    void commit(gated, !policy.enabled)
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
              <Switch on={policy.enabled} onToggle={toggleAll} label="Approvals" />
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
        ) : (
          /*
            Shown whether or not the policy is on, which is what makes the
            switch above reachable. Hidden behind `enabled`, there was no way to
            tick the first action and the server refuses to store a policy with
            none — so "Ask me before risky actions" could be turned off and
            never back on.
          */
          <Panel
            title="Gated actions"
            description={policy.enabled
              ? `${gated.size} of ${gateable.length} actions need you`
              : `Nothing is being asked. Tick one and this switches on.`}
            source="permissions"
          >
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
        )}
      </div>
    </>
  )
}

/* ══ Team usage ════════════════════════════════════════ */
/**
 * The ranges the picker offers, all slices of one fetch.
 *
 * Sixteen weeks is the window the endpoint returns and the one the personal
 * page uses, so it stays the default — the shorter ranges answer "what has it
 * been doing lately" without another round trip.
 */
const RANGES = [
  { days: 7, short: '7d' },
  { days: 30, short: '30d' },
  { days: USAGE_DAYS, short: '16w' },
] as const

const RANGE_LABEL: Record<number, string> = {
  7: 'Daily spend, last 7 days',
  30: 'Daily spend, last 30 days',
  [USAGE_DAYS]: `Daily spend, last ${USAGE_WEEKS} weeks`,
}

export function TeamUsage({ replay }: Props) {
  const dept = useMyManagedDepartment()
  const [r1] = useStaged([320], replay)
  // The same window as the personal page, so the two calendars are comparable
  // and a manager is not reading their own sixteen weeks against a team thirty.
  // The full window is fetched once; the picker slices it here. A range change
  // is a different view of data already in hand, not a reason to ask again.
  const { usage, loading } = useTeamUsage(dept?.id, USAGE_DAYS)
  const [range, setRange] = useState<number>(USAGE_DAYS)
  const shown = useMemo(() => usage.series.slice(-range), [usage.series, range])
  // The figures follow the range, so "busiest day" is always the busiest day of
  // the chart above it rather than of a window nobody is looking at.
  const spend = useMemo(() => summarizeSpend(shown), [shown])
  const shownTotal = useMemo(() => shown.reduce((sum, p) => sum + p.spendUsd, 0), [shown])

  if (!dept) return <NoTeam />

  const top = usage.people[0]
  const ready = r1 && !loading

  return (
    <>
      <PageHeader
        eyebrow={dept.name}
        title="Team usage"
        description={`What Divo did for your team over the last ${USAGE_WEEKS} weeks, and what it cost.`}
      />
      <TeamSwitch />
      <div className="ws-stack">
        {/*
          Nothing here is invented. The line is the team's own spend by day,
          priced by the helpers the personal figure uses, and every figure around
          it is read off the slice on screen — so changing the range changes the
          numbers with it rather than leaving them describing a window nobody is
          looking at.
        */}
        <Panel
          title="Team usage"
          description={RANGE_LABEL[range] ?? `Last ${range} days`}
          source="teamUsage"
          aside={ready ? (
            <Seg
              value={String(range)}
              onChange={(v) => setRange(Number(v))}
              options={RANGES.map((r) => ({ value: String(r.days), label: r.short }))}
            />
          ) : undefined}
        >
          <div className="ws-panel-body">
            {!ready ? (
              <>
                <div className="ws-stat3">
                  <div><Skel w={60} h={9} /><div style={{ height: 10 }} /><Skel w={90} h={26} /></div>
                  <div><Skel w={60} h={9} /><div style={{ height: 10 }} /><Skel w={90} h={26} /></div>
                  <div><Skel w={60} h={9} /><div style={{ height: 10 }} /><Skel w={90} h={26} /></div>
                </div>
                <div style={{ height: 22 }} />
                <Skel w="100%" h={130} block />
              </>
            ) : (
              <Fade>
                <div className="ws-stat3">
                  <div>
                    <div className="ws-lbl">Cost</div>
                    {/* The slice on screen, not the whole window — a figure that
                        disagreed with the chart under it would be the same fault
                        the calendar's own total had. */}
                    <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(shownTotal)}</div>
                    <div className="ws-sub" style={{ marginTop: 5 }}>
                      {range === USAGE_DAYS
                        ? `${usage.runs} task${usage.runs === 1 ? '' : 's'}`
                        : `of ${money(usage.spendUsd)} in ${USAGE_WEEKS} weeks`}
                    </div>
                  </div>
                  <div>
                    <div className="ws-lbl">Using Divo</div>
                    <div className="ws-num" style={{ marginTop: 8 }}>{usage.activePeople}</div>
                    {/* Adoption, not headcount — the number a manager acts on. */}
                    <div className="ws-sub" style={{ marginTop: 5 }}>of {usage.totalPeople} in the team</div>
                  </div>
                  <div>
                    <div className="ws-lbl">Busiest day</div>
                    <div className="ws-num" style={{ marginTop: 8 }}>
                      {spend.busiest ? money(spend.busiest.value) : '—'}
                    </div>
                    <div className="ws-sub" style={{ marginTop: 5 }}>
                      {spend.busiest ? dayLabel(spend.busiest.date) : 'Nothing yet'}
                    </div>
                  </div>
                </div>

                {/*
                  A trend, not a calendar. The calendar is on Home answering
                  "which days"; repeating it here would be the same widget
                  twice, and the question a manager brings to a team page is
                  whether spend is climbing or one week carried the quarter —
                  which a grid of squares makes you reconstruct square by
                  square.
                */}
                <div style={{ marginTop: 18 }}>
                  <TrendChart data={shown.map((p) => ({ date: p.date, value: p.spendUsd }))} />
                </div>
                <div className="ws-heat-facts">
                  <div>
                    <div className="ws-lbl">Days used</div>
                    {/* Out of the days on screen, not the days fetched. On the
                        7-day range this read "7 of 112", which is a true pair of
                        numbers describing two different windows. */}
                    <div style={{ marginTop: 5 }}>{spend.activeDays} of {shown.length}</div>
                  </div>
                  <div>
                    <div className="ws-lbl">On a day they used it</div>
                    <div style={{ marginTop: 5 }}>{spend.activeDays ? money(spend.perActiveDay) : '—'}</div>
                  </div>
                  <div>
                    <div className="ws-lbl">Last run</div>
                    <div style={{ marginTop: 5 }}>{spend.last ? dayLabel(spend.last) : '—'}</div>
                  </div>
                </div>
              </Fade>
            )}
          </div>
        </Panel>

        <Panel
          title="Cost by person"
          description={top && top.spendUsd > 0
            ? `${displayName(top.name, top.email)} is the heaviest`
            : undefined}
          source="teamUsage"
        >
          {!ready ? <SkelRows n={5} icon={false} /> : usage.people.length === 0 ? (
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
      </div>
    </>
  )
}
