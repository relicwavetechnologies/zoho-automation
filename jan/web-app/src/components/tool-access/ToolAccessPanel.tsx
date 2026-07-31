import { AlertTriangle, ArrowLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  getDivoDepartmentManagerApproval,
  getDivoToolManageSnapshot,
  setDivoDepartmentManagerApproval,
  setDivoDepartmentMemberToolAction,
  setDivoDepartmentRoleToolAction,
  setDivoGlobalToolAction,
  type DepartmentManagerApprovalPolicy,
  type DepartmentToolManageSnapshot,
  type DivoToolInventoryItem,
  type GlobalToolManageSnapshot,
  type ToolManageSnapshot,
} from '@/lib/divo-tools'
import { effectiveMark, grantedActions, groupMemberSummary, whyThisAccess } from '@/lib/tool-access-model'
import { readToolAccessScope } from '@/lib/tool-scope'
import { cn } from '@/lib/utils'

/**
 * Access, one level at a time.
 *
 * Google Workspace is 11 capabilities × 5 actions × 4 groups × N people. The
 * old screen painted all of it at once, under three headings with three
 * vocabularies — role access, member exceptions, company ceiling. Here you pick
 * a capability, then a group or a person, and each step is a table small enough
 * to read. The ceiling appears where it bites: as a locked switch with a reason.
 */

type Scope = { kind: 'company' } | { kind: 'department'; department: { id: string; name: string } }

export function ToolAccessPanel({ items, scope, onUpdated }: {
  items: DivoToolInventoryItem[]
  scope: Scope
  onUpdated?: () => void
}) {
  const [capabilityId, setCapabilityId] = useState<string | null>(items.length === 1 ? items[0]!.tool.toolId : null)
  const capability = capabilityId ? items.find(item => item.tool.toolId === capabilityId) ?? null : null

  useEffect(() => {
    // A tool with one capability has no list worth showing; drop straight in.
    if (items.length === 1) setCapabilityId(items[0]!.tool.toolId)
  }, [items])

  if (!items.length) return <AccessEmpty title="Nothing to configure" description="Divo did not return any capabilities for this tool." />
  if (!capability) return <CapabilityList items={items} scope={scope} onOpen={setCapabilityId} />

  return (
    <div className="flex flex-col gap-4">
      {items.length > 1 ? (
        <button className="flex w-fit items-center gap-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setCapabilityId(null)}>
          <ArrowLeft className="size-3.5" />All capabilities
          <span className="text-border">/</span>
          <span className="text-foreground">{capability.tool.name}</span>
        </button>
      ) : null}
      <CapabilityAccess key={capability.tool.toolId} item={capability} scope={scope} onUpdated={onUpdated} />
    </div>
  )
}

/** Level one: which capability, and how far it currently reaches. */
function CapabilityList({ items, scope, onOpen }: {
  items: DivoToolInventoryItem[]
  scope: Scope
  onOpen: (toolId: string) => void
}) {
  return (
    <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Capability</TableHead>
            <TableHead>What it does</TableHead>
            <TableHead className="w-10"><span className="sr-only">Open</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map(item => {
            const fixed = item.origins.some(origin => origin.kind === 'local' || origin.kind === 'system')
            const manageable = item.managementScopes.length > 0
            return (
              <TableRow
                key={item.tool.toolId}
                className={manageable ? 'cursor-pointer' : undefined}
                onClick={manageable ? () => onOpen(item.tool.toolId) : undefined}
              >
                <TableCell>
                  <div className="font-medium">{item.tool.name}</div>
                  {fixed ? <div className="mt-0.5 text-xs text-muted-foreground">Fixed by Divo</div> : null}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{item.tool.description}</TableCell>
                <TableCell className="text-muted-foreground">
                  {manageable ? <ChevronRight className="size-4" /> : <span className="text-xs">{scope.kind === 'company' ? 'Company only' : 'View only'}</span>}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

/** Level two: one capability, seen by group or by person. */
function CapabilityAccess({ item, scope, onUpdated }: {
  item: DivoToolInventoryItem
  scope: Scope
  onUpdated?: () => void
}) {
  const [snapshot, setSnapshot] = useState<DepartmentToolManageSnapshot | GlobalToolManageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [axis, setAxis] = useState<'groups' | 'people'>('groups')
  const [saving, setSaving] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ kind: 'group'; id: string } | { kind: 'person'; id: string } | null>(null)
  const generation = useRef(0)

  const managementScope = useMemo(
    () => scope.kind === 'company'
      ? item.managementScopes.find(candidate => candidate.kind === 'global')
      : item.managementScopes.find(candidate => candidate.kind === 'department' && candidate.department.id === scope.department.id),
    [item.managementScopes, scope],
  )

  const load = useCallback(async () => {
    if (!managementScope) return
    const mine = ++generation.current
    setSnapshot(null)
    setError(null)
    try {
      const result = await getDivoToolManageSnapshot(item.tool.toolId, managementScope)
      if (generation.current === mine) setSnapshot(result)
    } catch (loadError) {
      if (generation.current === mine) setError(String(loadError))
    }
  }, [item.tool.toolId, managementScope])

  useEffect(() => { void load() }, [load])

  const write = async (key: string, action: () => Promise<ToolManageSnapshot>) => {
    setSaving(key)
    try {
      setSnapshot(await action())
      onUpdated?.()
    } catch (writeError) {
      toast.error('Could not change this access', { description: String(writeError) })
      await load()
    } finally {
      setSaving(null)
    }
  }

  // Nothing to manage is not the same as nothing to say. Someone who cannot
  // configure a tool still needs to know what they are allowed to do with it.
  if (!managementScope) return <YourAccess item={item} />
  if (error) return <AccessEmpty title="Could not load access" description={error} />
  if (!snapshot) return <div className="flex flex-col gap-2">{[0, 1, 2].map(row => <Skeleton key={row} className="h-14 w-full rounded-lg" />)}</div>

  if (isGlobalSnapshot(snapshot)) {
    return <CompanyPolicyTable snapshot={snapshot} saving={saving} onToggle={write} />
  }

  // TypeScript cannot discriminate a union on a nested `scope.kind`, so the
  // guard above is what makes the rest of this a department snapshot.
  const departmentSnapshot: DepartmentToolManageSnapshot = snapshot
  const department = departmentSnapshot.scope.department
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border">
          <Button variant={axis === 'groups' ? 'secondary' : 'ghost'} size="sm" className="rounded-none border-0" onClick={() => setAxis('groups')}>By group</Button>
          <Button variant={axis === 'people' ? 'secondary' : 'ghost'} size="sm" className="rounded-none border-0 border-l" onClick={() => setAxis('people')}>By person</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {axis === 'groups' ? 'Set the rule once for a group. This is the normal way.' : 'What each person can actually do, exceptions included.'}
        </p>
      </div>

      <CeilingNotice snapshot={departmentSnapshot} />

      {axis === 'groups'
        ? <GroupTable snapshot={departmentSnapshot} saving={saving} onToggle={write} onOpenGroup={id => setSelected({ kind: 'group', id })} />
        : <PersonTable snapshot={departmentSnapshot} onOpenPerson={id => setSelected({ kind: 'person', id })} />}

      <ApprovalRow department={department} snapshot={departmentSnapshot} />

      <DetailSheet
        snapshot={departmentSnapshot}
        selected={selected}
        saving={saving}
        onClose={() => setSelected(null)}
        onToggle={write}
      />
    </div>
  )
}

/** Actions company policy blocks for ordinary members, said once. */
function CeilingNotice({ snapshot }: { snapshot: DepartmentToolManageSnapshot }) {
  const memberCeiling = snapshot.companyCeiling.find(entry => entry.role === 'MEMBER')
  const blocked = snapshot.supportedActions.filter(action => !memberCeiling?.actions.includes(action))
  if (!blocked.length) return null
  const total = blocked.length >= snapshot.supportedActions.length

  return (
    <Alert className="border-border/70 bg-card/40">
      <AlertTriangle />
      <AlertTitle>
        {total
          ? `Company policy keeps ${snapshot.tool.name} off for members`
          : `Company policy blocks ${blocked.map(action => snapshot.actionLabels[action] ?? action).join(' and ')}`}
      </AlertTitle>
      <AlertDescription>
        You can still set the rule for a group — it starts working the moment a company admin raises the policy.
        Until then only company admins are unaffected by it.
      </AlertDescription>
    </Alert>
  )
}

function GroupTable({ snapshot, saving, onToggle, onOpenGroup }: {
  snapshot: DepartmentToolManageSnapshot
  saving: string | null
  onToggle: (key: string, action: () => Promise<ToolManageSnapshot>) => Promise<void>
  onOpenGroup: (roleId: string) => void
}) {
  const memberCeiling = snapshot.companyCeiling.find(entry => entry.role === 'MEMBER')
  return (
    <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Group</TableHead>
            <TableHead className="w-20 text-center">People</TableHead>
            {snapshot.supportedActions.map(action => (
              <TableHead key={action} className="min-w-24 text-center">{snapshot.actionLabels[action] ?? action}</TableHead>
            ))}
            <TableHead className="w-10"><span className="sr-only">Open</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshot.roles.map(role => {
            const people = snapshot.members.filter(member => member.roleId === role.id)
            return (
              <TableRow key={role.id}>
                <TableCell>
                  <button className="text-left" onClick={() => onOpenGroup(role.id)}>
                    <div className="font-medium">{role.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {groupMemberSummary(people.map(person => (person.name ?? person.email ?? '').split(' ')[0]!).filter(Boolean))}
                    </div>
                  </button>
                </TableCell>
                <TableCell className="text-center text-muted-foreground">{people.length}</TableCell>
                {snapshot.supportedActions.map(action => {
                  const state = snapshot.roleActionStates.find(entry => entry.roleId === role.id && entry.actionGroup === action)
                  const blocked = !memberCeiling?.actions.includes(action)
                  const key = `role:${role.id}:${action}`
                  if (!state) return <TableCell key={action} className="text-center text-xs text-muted-foreground">—</TableCell>
                  return (
                    <TableCell key={action} className="text-center">
                      <Switch
                        aria-label={`${role.name} ${snapshot.actionLabels[action] ?? action}`}
                        checked={state.configuredAllowed}
                        loading={saving === key}
                        disabled={blocked || saving !== null}
                        onCheckedChange={allowed => void onToggle(key, () => setDivoDepartmentRoleToolAction(
                          snapshot.tool.toolId, snapshot.scope.department.id, role.id, action, allowed))}
                      />
                    </TableCell>
                  )
                })}
                <TableCell>
                  <Button variant="ghost" size="icon" aria-label={`Open ${role.name}`} onClick={() => onOpenGroup(role.id)}>
                    <ChevronRight className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

function PersonTable({ snapshot, onOpenPerson }: {
  snapshot: DepartmentToolManageSnapshot
  onOpenPerson: (userId: string) => void
}) {
  return (
    <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Group</TableHead>
            {snapshot.supportedActions.map(action => (
              <TableHead key={action} className="min-w-20 text-center">{snapshot.actionLabels[action] ?? action}</TableHead>
            ))}
            <TableHead className="w-10"><span className="sr-only">Open</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {snapshot.members.map(member => {
            const role = snapshot.roles.find(candidate => candidate.id === member.roleId)
            return (
              <TableRow key={member.userId} className="cursor-pointer" onClick={() => onOpenPerson(member.userId)}>
                <TableCell>
                  <div className="font-medium">{member.name ?? member.email ?? member.userId}</div>
                  {member.email ? <div className="mt-0.5 text-xs text-muted-foreground">{member.email}</div> : null}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{role?.name ?? '—'}</TableCell>
                {snapshot.supportedActions.map(action => {
                  const state = snapshot.memberActionStates.find(entry => entry.userId === member.userId && entry.actionGroup === action)
                  const mark = state ? effectiveMark(state) : 'not_allowed'
                  return (
                    <TableCell key={action} className="text-center">
                      <AccessMark mark={mark} exception={state?.configuredProvenance === 'member_override'} />
                    </TableCell>
                  )
                })}
                <TableCell className="text-muted-foreground"><ChevronRight className="size-4" /></TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <CardContent className="flex flex-wrap gap-4 border-t p-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Dot className="bg-emerald-400" />allowed</span>
        <span className="flex items-center gap-1.5"><Dot className="bg-amber-400" />set here, blocked by company policy</span>
        <span className="flex items-center gap-1.5"><Dot className="bg-muted-foreground/40" />not allowed</span>
      </CardContent>
    </Card>
  )
}

function AccessMark({ mark, exception }: { mark: ReturnType<typeof effectiveMark>; exception: boolean }) {
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <Dot className={cn(
        mark === 'allowed' && 'bg-emerald-400',
        mark === 'blocked_by_company' && 'bg-amber-400',
        mark === 'not_allowed' && 'bg-muted-foreground/40',
      )} />
      {exception ? <span className="text-[10px] text-muted-foreground">exception</span> : null}
    </span>
  )
}

function Dot({ className }: { className?: string }) {
  return <span className={cn('inline-block size-2 rounded-full', className)} />
}

/** The company ceiling itself — never a grant, only what departments may grant. */
function CompanyPolicyTable({ snapshot, saving, onToggle }: {
  snapshot: GlobalToolManageSnapshot
  saving: string | null
  onToggle: (key: string, action: () => Promise<ToolManageSnapshot>) => Promise<void>
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        This is the ceiling, not a grant. Switching something on here does not give it to anybody — it lets
        departments give it out.
      </p>
      <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company role</TableHead>
              {snapshot.supportedActions.map(action => (
                <TableHead key={action} className="min-w-24 text-center">{snapshot.actionLabels[action] ?? action}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.roles.map(role => (
              <TableRow key={role.role}>
                <TableCell className="font-medium">{role.role.replace(/_/g, ' ').toLowerCase()}</TableCell>
                {snapshot.supportedActions.map(action => {
                  const state = role.actions.find(entry => entry.actionGroup === action)
                  const key = `global:${role.role}:${action}`
                  if (!state) return <TableCell key={action} className="text-center text-xs text-muted-foreground">—</TableCell>
                  return (
                    <TableCell key={action} className="text-center">
                      <Switch
                        aria-label={`${role.role} ${snapshot.actionLabels[action] ?? action}`}
                        checked={state.effectiveAllowed}
                        loading={saving === key}
                        disabled={saving !== null || state.clampReason === 'company_tool_disabled'}
                        onCheckedChange={enabled => void onToggle(key, () => setDivoGlobalToolAction(
                          snapshot.tool.toolId, role.role, action, enabled))}
                      />
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

/**
 * Which actions pause for a manager's yes. Reads are never gated — an approval
 * on a read would stop the agent to ask permission to look at something.
 */
function ApprovalRow({ department, snapshot }: {
  department: { id: string; name: string }
  snapshot: DepartmentToolManageSnapshot
}) {
  const [policy, setPolicy] = useState<DepartmentManagerApprovalPolicy | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    void getDivoDepartmentManagerApproval(department.id)
      .then(result => { if (live) setPolicy(result) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [department.id])

  const gatable = snapshot.supportedActions.filter(action => action !== 'read')
  if (!gatable.length) return null

  const required = (action: string) => Boolean(policy?.enabled
    && policy.requiredActions.some(entry => entry.toolId === snapshot.tool.toolId && entry.actions.includes(action)))

  const update = async (action: string, shouldRequire: boolean) => {
    if (!policy) return
    setSaving(action)
    const selected = new Map(policy.requiredActions.map(entry => [entry.toolId, new Set(entry.actions)]))
    const actions = selected.get(snapshot.tool.toolId) ?? new Set<string>()
    if (shouldRequire) actions.add(action)
    else actions.delete(action)
    if (actions.size) selected.set(snapshot.tool.toolId, actions)
    else selected.delete(snapshot.tool.toolId)
    const requiredActions = [...selected.entries()].map(([toolId, entries]) => ({ toolId, actions: [...entries].sort() }))
    try {
      setPolicy(await setDivoDepartmentManagerApproval(department.id, { enabled: requiredActions.length > 0, requiredActions }))
      toast.success(shouldRequire ? 'Divo will ask before doing this' : 'Approval removed')
    } catch (error) {
      toast.error('Could not change the approval rule', { description: String(error) })
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card className="border-border/70 bg-card/30 shadow-none">
      <CardContent className="p-4">
        <div className="text-sm font-medium">Ask a manager first</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Divo pauses and requests approval before doing these, even for people who are allowed.
          {failed ? ' Approval rules could not be loaded, so these are disabled.' : ''}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {gatable.map(action => (
            <label key={action} className="flex items-center gap-2.5 rounded-full border border-border/70 px-3 py-1.5 text-xs">
              {snapshot.actionLabels[action] ?? action}
              <Switch
                aria-label={`Ask a manager before ${snapshot.actionLabels[action] ?? action}`}
                checked={required(action)}
                loading={saving === action}
                disabled={policy === null || saving !== null}
                onCheckedChange={shouldRequire => void update(action, shouldRequire)}
              />
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/** Level three: one group or one person, with the reason chain. */
function DetailSheet({ snapshot, selected, saving, onClose, onToggle }: {
  snapshot: DepartmentToolManageSnapshot
  selected: { kind: 'group'; id: string } | { kind: 'person'; id: string } | null
  saving: string | null
  onClose: () => void
  onToggle: (key: string, action: () => Promise<ToolManageSnapshot>) => Promise<void>
}) {
  const memberCeiling = snapshot.companyCeiling.find(entry => entry.role === 'MEMBER')
  const role = selected?.kind === 'group' ? snapshot.roles.find(candidate => candidate.id === selected.id) : null
  const person = selected?.kind === 'person' ? snapshot.members.find(candidate => candidate.userId === selected.id) : null
  const personRole = person ? snapshot.roles.find(candidate => candidate.id === person.roleId) : null

  return (
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{role?.name ?? person?.name ?? person?.email ?? 'Access'}</SheetTitle>
          <SheetDescription>
            {role
              ? `${snapshot.tool.name} in ${snapshot.scope.department.name} · ${snapshot.members.filter(member => member.roleId === role.id).length} people`
              : `${personRole?.name ?? 'No group'} in ${snapshot.scope.department.name}`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-1 p-4">
          {snapshot.supportedActions.map(action => {
            const blocked = !memberCeiling?.actions.includes(action)
            if (role) {
              const state = snapshot.roleActionStates.find(entry => entry.roleId === role.id && entry.actionGroup === action)
              if (!state) return null
              const key = `role:${role.id}:${action}`
              return (
                <div key={action} className="flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0">
                  <div>
                    <p className="text-sm">{snapshot.actionLabels[action] ?? action}</p>
                    {blocked ? <p className="text-xs text-amber-400">Company policy blocks this</p> : null}
                  </div>
                  <Switch
                    aria-label={`${role.name} ${snapshot.actionLabels[action] ?? action}`}
                    checked={state.configuredAllowed}
                    loading={saving === key}
                    disabled={blocked || saving !== null}
                    onCheckedChange={allowed => void onToggle(key, () => setDivoDepartmentRoleToolAction(
                      snapshot.tool.toolId, snapshot.scope.department.id, role.id, action, allowed))}
                  />
                </div>
              )
            }
            if (!person) return null
            const state = snapshot.memberActionStates.find(entry => entry.userId === person.userId && entry.actionGroup === action)
            if (!state) return null
            const key = `member:${person.userId}:${action}`
            return (
              <div key={action} className="flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0">
                <div>
                  <p className={cn('text-sm', state.effectiveAllowed ? 'text-emerald-400' : 'text-muted-foreground')}>
                    {snapshot.actionLabels[action] ?? action}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {whyThisAccess({ ...state, roleName: personRole?.name ?? 'their' })}
                  </p>
                </div>
                <Switch
                  aria-label={`${person.name ?? person.userId} ${snapshot.actionLabels[action] ?? action}`}
                  checked={state.configuredAllowed}
                  loading={saving === key}
                  disabled={blocked || saving !== null}
                  onCheckedChange={allowed => void onToggle(key, () => setDivoDepartmentMemberToolAction(
                    snapshot.tool.toolId, snapshot.scope.department.id, person.userId, action, allowed))}
                />
              </div>
            )
          })}
          {person ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Changing anything here writes a personal exception, which stays in place even if {personRole?.name ?? 'their group'} changes.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The access panel with its scope resolved from what the tools list was
 * showing. Falls back to a department the person actually manages, then to
 * company policy, so a direct link to a tool still lands somewhere real.
 */
export function ToolAccessBlock({ items, onUpdated }: { items: DivoToolInventoryItem[]; onUpdated?: () => void }) {
  const scope = useMemo<Scope>(() => {
    const preferred = readToolAccessScope()
    const departments = items.flatMap(item => item.managementScopes.flatMap(candidate => candidate.kind === 'department' ? [candidate.department] : []))
    const chosen = departments.find(department => department.id === preferred)
    if (chosen) return { kind: 'department', department: chosen }
    if (preferred === 'company' && items.some(item => item.managementScopes.some(candidate => candidate.kind === 'global'))) return { kind: 'company' }
    if (departments[0]) return { kind: 'department', department: departments[0] }
    return { kind: 'company' }
  }, [items])

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium">Access</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {scope.kind === 'company'
            ? 'What any department is allowed to grant.'
            : `Who in ${scope.department.name} can use this, and what they can do.`}
        </p>
      </div>
      <ToolAccessPanel items={items} scope={scope} onUpdated={onUpdated} />
    </section>
  )
}

function isGlobalSnapshot(snapshot: ToolManageSnapshot): snapshot is GlobalToolManageSnapshot {
  return snapshot.scope.kind === 'global'
}

/** Read-only: what this person can do, without a word of the permission model. */
function YourAccess({ item }: { item: DivoToolInventoryItem }) {
  const fixed = item.origins.find(origin => origin.kind === 'local' || origin.kind === 'system')
  const actions = [...new Set(item.origins.flatMap(origin => 'allowedActions' in origin ? origin.allowedActions : []))]

  return (
    <Card className="border-border/70 bg-card/30 shadow-none">
      <CardContent className="p-4">
        <p className="text-sm font-medium">What you can do</p>
        {actions.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.map(action => <Badge key={action} variant="secondary">{ACTION_VERBS[action] ?? action}</Badge>)}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Nothing yet. Ask your manager for access to {item.tool.name}.</p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {fixed && 'reason' in fixed ? fixed.reason : 'Set by your department. You cannot change it here.'}
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Action groups named for a reader. The backend phrases these with the tool's
 * noun ("Send email"); here there is no snapshot to carry one, so the verb
 * alone has to do the work.
 */
const ACTION_VERBS: Record<string, string> = {
  read: 'View', create: 'Add', update: 'Edit', delete: 'Delete', send: 'Send', execute: 'Run',
}

function AccessEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 p-6 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export { grantedActions }
