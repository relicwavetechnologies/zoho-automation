import { RefreshCw } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Switch } from '@/components/ui/switch'
import { ToolInventoryMetadata } from '@/components/tool-access/ToolInventoryMetadata'
import {
  getDivoToolManageSnapshot,
  setDivoDepartmentMemberToolAction,
  setDivoDepartmentRoleToolAction,
  setDivoGlobalToolAction,
  type DepartmentToolManageSnapshot,
  type DivoToolInventoryItem,
  type ToolManageSnapshot,
  type ToolManagementScope,
} from '@/lib/divo-tools'
import { CommittedToolAccessGeneration } from '@/lib/tool-access-generation'
import { cn } from '@/lib/utils'

type ToolAccessSectionProps = {
  items: DivoToolInventoryItem[]
  embedded?: boolean
  onUpdated?: () => void
}

export function ToolAccessSection({ items, embedded = false, onUpdated = () => {} }: ToolAccessSectionProps) {
  return (
    <section className={embedded ? 'space-y-4' : 'mx-auto my-6 w-full max-w-6xl space-y-4 px-6 lg:px-8'}>
      <div>
        <h2 className="text-lg font-medium">Tool access</h2>
        <p className="mt-1 text-sm text-muted-foreground">Configured and effective access returned by Divo.</p>
      </div>
      {items.map(item => item.managementScopes.length > 0 ? (
        <ManagedToolAccess key={item.tool.toolId} item={item} onUpdated={onUpdated} />
      ) : (
        <ToolAccessSummary key={item.tool.toolId} item={item} />
      ))}
    </section>
  )
}

function ManagedToolAccess({ item, onUpdated }: { item: DivoToolInventoryItem; onUpdated: () => void }) {
  const [selectedScopeKey, setSelectedScopeKey] = useState(() => scopeKey(item.managementScopes[0] ?? null))
  const [snapshot, setSnapshot] = useState<ToolManageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<{ key: string; generation: number } | null>(null)
  const generation = useRef(new CommittedToolAccessGeneration<DivoToolInventoryItem>())
  const scope = useMemo(
    () => item.managementScopes.find(candidate => scopeKey(candidate) === selectedScopeKey) ?? item.managementScopes[0] ?? null,
    [item, selectedScopeKey],
  )
  const currentScopeKey = scopeKey(scope)
  const lifecycleCandidate = useMemo(
    () => generation.current.candidate(item, currentScopeKey),
    [currentScopeKey, item],
  )
  const activeSaving = saving?.generation === generation.current.current ? saving.key : null

  useLayoutEffect(() => {
    lifecycleCandidate.commit()
  }, [lifecycleCandidate])

  useEffect(() => () => {
    generation.current.invalidateForEvent()
  }, [])

  useEffect(() => {
    let active = true
    const snapshotGeneration = generation.current.current
    if (!scope) return () => { active = false }
    setSnapshot(null)
    setError(null)
    void getDivoToolManageSnapshot(item.tool.toolId, scope)
      .then(result => { if (active && generation.current.current === snapshotGeneration) setSnapshot(result) })
      .catch(loadError => { if (active && generation.current.current === snapshotGeneration) setError(String(loadError)) })
    return () => { active = false }
  }, [item, scope])

  const update = async (key: string, action: () => Promise<ToolManageSnapshot>) => {
    const mutationGeneration = generation.current.current
    const remainsCurrent = () => generation.current.current === mutationGeneration
    setSaving({ key, generation: mutationGeneration })
    setError(null)
    try {
      const result = await action()
      if (!remainsCurrent()) return
      onUpdated()
      setSnapshot(result)
      toast.success('Tool access updated')
    } catch (updateError) {
      if (!remainsCurrent()) return
      onUpdated()
      setError('Access changed or this update was rejected. Tool access was refreshed.')
      if (scope) {
        try {
          const refreshed = await getDivoToolManageSnapshot(item.tool.toolId, scope)
          if (remainsCurrent()) setSnapshot(refreshed)
        } catch {
          if (remainsCurrent()) setSnapshot(null)
        }
      }
      if (remainsCurrent()) toast.error('Could not update tool access', { description: String(updateError) })
    } finally {
      if (remainsCurrent()) {
        setSaving(current => current?.generation === mutationGeneration && current.key === key ? null : current)
      }
    }
  }

  return (
    <section className="space-y-5 rounded-lg border border-border/70 bg-card/30 p-5">
      <header>
        <h3 className="text-base font-medium">Manage {item.tool.name}</h3>
        <p className="mt-1 text-sm text-muted-foreground">Only the roles, members, actions, and scopes returned by Divo can be changed here.</p>
        <ToolInventoryMetadata item={item} className="mt-3" />
      </header>
      {item.managementScopes.length > 1 ? (
        <label className="grid gap-1.5 text-sm font-medium">Scope
          <select value={scopeKey(scope)} onChange={event => {
            const nextScope = item.managementScopes.find(candidate => scopeKey(candidate) === event.target.value) ?? null
            if (scopeKey(nextScope) !== currentScopeKey) generation.current.invalidateForEvent()
            setSelectedScopeKey(scopeKey(nextScope))
          }} className="h-9 rounded-md border bg-background px-3 text-sm">
            {item.managementScopes.map(candidate => <option key={scopeKey(candidate)} value={scopeKey(candidate)}>{scopeLabel(candidate)}</option>)}
          </select>
        </label>
      ) : scope ? <p className="text-sm text-muted-foreground">Scope: {scopeLabel(scope)}</p> : null}
      {!snapshot && !error ? <AccessState title="Loading current access" description="Checking this scope with Divo." loading /> : null}
      {error ? <AccessState title="Could not load this scope" description={error} /> : null}
      {snapshot && isGlobalSnapshot(snapshot) ? <GlobalAccess snapshot={snapshot} saving={activeSaving} onUpdate={update} /> : null}
      {snapshot && !isGlobalSnapshot(snapshot) ? <DepartmentAccess snapshot={snapshot} saving={activeSaving} onUpdate={update} /> : null}
    </section>
  )
}

function ToolAccessSummary({ item }: { item: DivoToolInventoryItem }) {
  return <article className="rounded-lg border border-border/70 bg-card/30 p-4"><h3 className="font-medium">{item.tool.name}</h3><p className="mt-1 text-sm text-muted-foreground">{item.tool.description}</p><ToolInventoryMetadata item={item} className="mt-3" /></article>
}

function GlobalAccess({ snapshot, saving, onUpdate }: { snapshot: Extract<ToolManageSnapshot, { scope: { kind: 'global' } }>; saving: string | null; onUpdate: (key: string, action: () => Promise<ToolManageSnapshot>) => Promise<void> }) {
  return <AccessGroup title="Company role access" description="Exact action rules for company roles.">{snapshot.roles.map(role => <div key={role.role} className="rounded-md border p-3"><p className="text-sm font-medium">{role.role}</p><ActionToggles actions={role.actions.map(action => ({ actionGroup: action.actionGroup, displayedAllowed: action.effectiveAllowed, storedAllowed: action.storedAllowed, storedProvenance: action.storedProvenance, clampReason: action.clampReason }))} saving={saving} onToggle={(action, enabled) => onUpdate(`global-${role.role}-${action.actionGroup}`, () => setDivoGlobalToolAction(snapshot.tool.toolId, role.role, action.actionGroup, enabled))} keyFor={action => `global-${role.role}-${action.actionGroup}`} /></div>)}</AccessGroup>
}

function DepartmentAccess({ snapshot, saving, onUpdate }: { snapshot: DepartmentToolManageSnapshot; saving: string | null; onUpdate: (key: string, action: () => Promise<ToolManageSnapshot>) => Promise<void> }) {
  return <div className="space-y-5"><AccessGroup title={`${snapshot.scope.department.name} role access`} description="Only roles in this department are editable.">{snapshot.roles.map(role => <div key={role.id} className="rounded-md border p-3"><p className="text-sm font-medium">{role.name}</p><RoleActionToggles actions={snapshot.roleActionStates.filter(action => action.roleId === role.id)} saving={saving} onToggle={(action, allowed) => onUpdate(`role-${role.id}-${action.actionGroup}`, () => setDivoDepartmentRoleToolAction(snapshot.tool.toolId, snapshot.scope.department.id, role.id, action.actionGroup, allowed))} keyFor={action => `role-${role.id}-${action.actionGroup}`} /></div>)}</AccessGroup><AccessGroup title="Member exceptions" description="Current access is returned by Divo. Changing an action writes an explicit member exception.">{snapshot.members.map(member => <div key={member.userId} className="rounded-md border p-3"><p className="text-sm font-medium">{member.name ?? member.email ?? member.userId}</p><MemberActionToggles actions={snapshot.memberActionStates.filter(action => action.userId === member.userId)} saving={saving} onToggle={(action, allowed) => onUpdate(`member-${member.userId}-${action.actionGroup}`, () => setDivoDepartmentMemberToolAction(snapshot.tool.toolId, snapshot.scope.department.id, member.userId, action.actionGroup, allowed))} keyFor={action => `member-${member.userId}-${action.actionGroup}`} /></div>)}</AccessGroup><AccessGroup title="Company policy ceiling" description="Department allowances cannot exceed company policy.">{snapshot.companyCeiling.map(ceiling => <p key={ceiling.role} className="text-sm"><span className="font-medium">{ceiling.role}:</span> {ceiling.actions.length ? ceiling.actions.join(', ') : 'No actions'}</p>)}</AccessGroup></div>
}

type DisplayAction = { actionGroup: string; displayedAllowed: boolean; storedAllowed: boolean; storedProvenance?: 'default' | 'override'; clampReason?: 'company_tool_disabled' | null }

function ActionToggles({ actions, saving, onToggle, keyFor }: { actions: DisplayAction[]; saving: string | null; onToggle: (action: DisplayAction, enabled: boolean) => void; keyFor: (action: DisplayAction) => string }) {
  return <div className="mt-3 grid gap-2 sm:grid-cols-2">{actions.map(action => { const clamped = action.clampReason === 'company_tool_disabled'; const storedRule = `${action.storedAllowed ? 'Allow' : 'Deny'}${action.storedProvenance ? ` (${action.storedProvenance})` : ''}`; return <label key={action.actionGroup} className="flex items-center justify-between gap-3 text-sm"><span className="grid gap-0.5"><span>{action.actionGroup}</span>{clamped ? <><span className="text-xs text-muted-foreground">Effective access: Denied</span><span className="text-xs text-muted-foreground">Stored action rule: {storedRule} — resumes when the company tool is enabled</span><span className="text-xs text-muted-foreground">Disabled by company tool policy</span></> : null}</span><Switch checked={action.displayedAllowed} loading={saving === keyFor(action)} disabled={clamped || Boolean(saving)} onCheckedChange={enabled => onToggle(action, enabled)} /></label> })}</div>
}

function RoleActionToggles({ actions, saving, onToggle, keyFor }: { actions: DepartmentToolManageSnapshot['roleActionStates']; saving: string | null; onToggle: (action: DepartmentToolManageSnapshot['roleActionStates'][number], enabled: boolean) => void; keyFor: (action: DepartmentToolManageSnapshot['roleActionStates'][number]) => string }) {
  return <div className="mt-3 grid gap-2 sm:grid-cols-2">{actions.map(action => { const explanation = action.companyPolicyStatus === 'no_active_members' ? 'No active members in this role; policy applies to future members subject to company policy.' : action.companyPolicyStatus === 'company_tool_blocks_all_current_members' ? 'Company tool policy blocks all current role members.' : action.companyPolicyStatus === 'company_action_blocks_all_current_members' ? 'Company action policy blocks all current role members.' : 'Current-member effective access can vary with member exceptions and company policy.'; return <label key={action.actionGroup} className="flex items-center justify-between gap-3 text-sm"><span className="grid gap-0.5"><span>{action.actionGroup}</span><span className="text-xs text-muted-foreground">Configured role policy: {action.configuredAllowed ? 'Allow' : 'Deny'} ({action.configuredProvenance === 'department_role' ? 'role rule' : 'default'})</span><span className="text-xs text-muted-foreground">{explanation}</span></span><Switch checked={action.configuredAllowed} loading={saving === keyFor(action)} disabled={Boolean(saving)} onCheckedChange={allowed => onToggle(action, allowed)} /></label> })}</div>
}

function MemberActionToggles({ actions, saving, onToggle, keyFor }: { actions: DepartmentToolManageSnapshot['memberActionStates']; saving: string | null; onToggle: (action: DepartmentToolManageSnapshot['memberActionStates'][number], enabled: boolean) => void; keyFor: (action: DepartmentToolManageSnapshot['memberActionStates'][number]) => string }) {
  return <div className="mt-3 grid gap-2 sm:grid-cols-2">{actions.map(action => { const configuredBy = action.configuredProvenance === 'member_override' ? 'Explicit member exception' : action.configuredProvenance === 'department_role' ? 'Department role rule' : 'Department default'; const effectiveBlock = action.effectiveBlockReason === 'company_tool_disabled' ? 'Blocked by company tool policy' : action.effectiveBlockReason === 'company_action_disabled' ? 'Blocked by company action policy' : null; return <label key={action.actionGroup} className="flex items-center justify-between gap-3 text-sm"><span className="grid gap-0.5"><span>{action.actionGroup}</span><span className="text-xs text-muted-foreground">Configured access: {action.configuredAllowed ? 'Allow' : 'Deny'}</span><span className="text-xs text-muted-foreground">{configuredBy}</span><span className="text-xs text-muted-foreground">Effective access: {action.effectiveAllowed ? 'Allowed' : 'Denied'}</span>{effectiveBlock ? <span className="text-xs text-muted-foreground">{effectiveBlock}</span> : null}</span><Switch checked={action.configuredAllowed} loading={saving === keyFor(action)} disabled={Boolean(saving)} onCheckedChange={allowed => onToggle(action, allowed)} /></label> })}</div>
}

function AccessGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="space-y-2"><div><h3 className="font-medium">{title}</h3><p className="text-sm text-muted-foreground">{description}</p></div><div className="space-y-2">{children}</div></section>
}

function AccessState({ title, description, loading = false }: { title: string; description: string; loading?: boolean }) {
  return <div className="rounded-lg border border-dashed border-border/70 p-4 text-center"><div className="flex justify-center">{loading ? <RefreshCw className="size-5 animate-spin text-muted-foreground" /> : null}</div><h3 className={cn('font-medium', loading && 'mt-2')}>{title}</h3><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
}

function scopeKey(scope: ToolManagementScope | null): string { if (!scope) return ''; return scope.kind === 'global' ? 'global' : `department:${scope.department.id}` }
function scopeLabel(scope: ToolManagementScope): string { return scope.kind === 'global' ? scope.label : scope.department.name }
function isGlobalSnapshot(snapshot: ToolManageSnapshot): snapshot is Extract<ToolManageSnapshot, { scope: { kind: 'global' } }> { return snapshot.scope.kind === 'global' }
