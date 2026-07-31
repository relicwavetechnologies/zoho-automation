import { Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  createDivoDepartmentRole,
  deleteDivoDepartmentRole,
  getDivoDepartmentManageSnapshot,
  removeDivoDepartmentMember,
  saveDivoDepartmentMember,
  searchDivoDepartmentCandidates,
  updateDivoDepartmentRole,
  type DepartmentCandidate,
  type DepartmentManagementRole,
  type DepartmentManagementSnapshot,
} from '@/lib/divo-tools'

type Props = {
  department: { id: string; name: string }
  initialFocus?: DepartmentTeamDialogFocus
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

export type DepartmentTeamDialogFocus = 'overview' | 'roles' | 'people'

const roleSlug = (name: string) => name.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 40)

export function DepartmentTeamDialog({ department, initialFocus = 'overview', open, onOpenChange, onChanged }: Props) {
  const [snapshot, setSnapshot] = useState<DepartmentManagementSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<DepartmentCandidate[]>([])
  const [roleName, setRoleName] = useState('')
  const [selectedRoleId, setSelectedRoleId] = useState('')
  const [roleNames, setRoleNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const assignableRoles = useMemo(() => snapshot?.roles.filter(role => role.slug !== 'MANAGER') ?? [], [snapshot])
  const defaultRoleId = useMemo(() => assignableRoles.find(role => role.isDefault)?.id ?? assignableRoles[0]?.id ?? '', [assignableRoles])

  const load = useCallback(async (showError = true) => {
    setLoading(true)
    try {
      const next = await getDivoDepartmentManageSnapshot(department.id)
      setSnapshot(next)
      setSelectedRoleId(current => current || next.roles.find(role => role.isDefault && role.slug !== 'MANAGER')?.id || next.roles.find(role => role.slug !== 'MANAGER')?.id || '')
      setRoleNames(Object.fromEntries(next.roles.map(role => [role.id, role.name])))
    } catch (error) {
      setSnapshot(null)
      if (showError) toast.error('Could not load department team', { description: String(error) })
    } finally {
      setLoading(false)
    }
  }, [department.id])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setCandidates([])
      return
    }
    void load()
  }, [load, open])

  const changed = async (action: () => Promise<unknown>, success: string) => {
    setSaving(true)
    try {
      await action()
      await load()
      onChanged()
      toast.success(success)
    } catch (error) {
      await load(false)
      onChanged()
      if (/HTTP 403|forbidden/i.test(String(error))) onOpenChange(false)
      toast.error('Could not update department team', { description: String(error) })
    } finally {
      setSaving(false)
    }
  }

  const search = async () => {
    const term = query.trim()
    if (!term) return
    setLoading(true)
    try {
      setCandidates(await searchDivoDepartmentCandidates(department.id, term))
    } catch (error) {
      toast.error('Could not search people', { description: String(error) })
    } finally {
      setLoading(false)
    }
  }

  const createRole = () => {
    const name = roleName.trim()
    if (!name) return
    void changed(() => createDivoDepartmentRole(department.id, name, roleSlug(name)), 'Role created')
    setRoleName('')
  }

  const saveRole = (role: DepartmentManagementRole) => {
    const name = roleNames[role.id]?.trim()
    if (!name || name === role.name) return
    void changed(() => updateDivoDepartmentRole(department.id, role.id, name), 'Role updated')
  }

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manage {department.name} team</DialogTitle>
          <DialogDescription>Manage ordinary members and custom roles for this department. Manager assignments remain company-admin only.</DialogDescription>
        </DialogHeader>

        {loading && !snapshot ? <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><RefreshCw className="size-4 animate-spin" />Loading team…</div> : null}
        {snapshot ? <div className="space-y-5 py-1">
          <section className="rounded-lg border border-border/70 p-4">
            <div className="flex items-start justify-between gap-4">
              <div><h3 className="text-sm font-medium">Roles</h3><p className="mt-1 text-xs text-muted-foreground">Custom roles are department-scoped and use personalised Zoho visibility.</p></div>
              <span className="text-xs text-muted-foreground">{snapshot.roles.length} roles</span>
            </div>
            <div className="mt-3 flex gap-2">
              <Input autoFocus={initialFocus === 'roles'} value={roleName} onChange={event => setRoleName(event.target.value)} placeholder="New role name" disabled={saving} />
              <Button size="sm" onClick={createRole} disabled={!roleName.trim() || saving}><Plus className="size-4" />Create</Button>
            </div>
            <div className="mt-3 space-y-2">
              {snapshot.roles.map(role => <div key={role.id} className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                {role.isSystem ? <div className="min-w-0 flex-1"><p className="text-sm font-medium">{role.name}</p><p className="text-xs text-muted-foreground">Built-in · protected</p></div> : <>
                  <Input className="h-8 flex-1" value={roleNames[role.id] ?? role.name} onChange={event => setRoleNames(names => ({ ...names, [role.id]: event.target.value }))} disabled={saving} />
                  <Button variant="outline" size="sm" onClick={() => saveRole(role)} disabled={saving || roleNames[role.id] === role.name}>Save</Button>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${role.name}`} onClick={() => void changed(() => deleteDivoDepartmentRole(department.id, role.id), 'Role deleted')} disabled={saving}><Trash2 className="size-4" /></Button>
                </>}
              </div>)}
            </div>
          </section>

          <section className="rounded-lg border border-border/70 p-4">
            <div><h3 className="text-sm font-medium">Add people</h3><p className="mt-1 text-xs text-muted-foreground">Search the synced directory. People outside this workspace remain visible but cannot be added.</p></div>
            <div className="mt-3 flex gap-2"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input autoFocus={initialFocus === 'people'} className="pl-9" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search() }} placeholder="Search by name or email" disabled={loading} /></div><Button variant="outline" onClick={() => void search()} disabled={!query.trim() || loading}>Search</Button></div>
            {candidates.length ? <div className="mt-3 max-h-48 overflow-y-auto rounded-md border border-border/60">
              {candidates.map(candidate => {
                const canAdd = Boolean(candidate.userId && candidate.isWorkspaceMember && !candidate.isAlreadyAssigned && selectedRoleId)
                return <div key={candidate.channelIdentityId} className="flex items-center gap-2 border-b border-border/60 p-2 last:border-b-0">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{candidate.name ?? candidate.larkDisplayName ?? candidate.email ?? 'Unnamed directory user'}</p><p className="truncate text-xs text-muted-foreground">{candidate.email ?? 'No email'} · {candidate.isWorkspaceMember ? candidate.isAlreadyAssigned ? 'Already in this department' : 'Workspace member' : 'Not an active workspace member'}</p></div>
                  <Button size="sm" variant="outline" disabled={!canAdd || saving} onClick={() => candidate.userId && void changed(() => saveDivoDepartmentMember(department.id, candidate.userId!, selectedRoleId || defaultRoleId), 'Member added')}>{candidate.isAlreadyAssigned ? 'Added' : candidate.isWorkspaceMember ? 'Add' : 'Unavailable'}</Button>
                </div>
              })}
            </div> : null}
          </section>

          <section className="rounded-lg border border-border/70 p-4">
            <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-medium">Current people</h3><p className="mt-1 text-xs text-muted-foreground">Role changes apply immediately to this department’s tool policy.</p></div><span className="text-xs text-muted-foreground">{snapshot.memberships.length} active</span></div>
            <div className="mt-3 space-y-2">
              {snapshot.memberships.map(member => {
                const protectedManager = member.roleSlug === 'MANAGER'
                return <div key={member.id} className="flex items-center gap-2 rounded-md border border-border/60 p-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.name ?? member.email}</p><p className="truncate text-xs text-muted-foreground">{member.email} · {protectedManager ? 'Manager · company-admin managed' : member.roleName}</p></div>
                  {protectedManager ? null : <><select aria-label={`Role for ${member.email}`} className="h-8 max-w-36 rounded-md border border-border bg-background px-2 text-xs" defaultValue={member.roleId} disabled={saving} onChange={event => void changed(() => saveDivoDepartmentMember(department.id, member.userId, event.target.value), 'Member role updated')}>{assignableRoles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select><Button variant="ghost" size="icon" aria-label={`Remove ${member.email}`} onClick={() => void changed(() => removeDivoDepartmentMember(department.id, member.userId), 'Member removed')} disabled={saving}><Trash2 className="size-4" /></Button></>}
                </div>
              })}
            </div>
          </section>
        </div> : null}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
