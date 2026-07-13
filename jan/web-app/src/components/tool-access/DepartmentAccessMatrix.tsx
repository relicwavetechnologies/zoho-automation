import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  getDivoToolManageSnapshot,
  setDivoDepartmentRoleToolAction,
  type DepartmentManagementRole,
  type DepartmentToolManageSnapshot,
  type DivoToolInventoryItem,
} from '@/lib/divo-tools'

type Props = {
  department: { id: string; name: string }
  items: DivoToolInventoryItem[]
  query: string
  roles: DepartmentManagementRole[]
  onUpdated: () => void
}

export function DepartmentAccessMatrix({ department, items, query, roles, onUpdated }: Props) {
  const [snapshots, setSnapshots] = useState<Record<string, DepartmentToolManageSnapshot>>({})
  const [loading, setLoading] = useState(true)
  const [failedCount, setFailedCount] = useState(0)
  const [saving, setSaving] = useState<string | null>(null)
  const requestGeneration = useRef(0)

  const manageableItems = useMemo(() => items.filter(item => item.managementScopes.some(scope => scope.kind === 'department' && scope.department.id === department.id)), [department.id, items])
  // Stable key over the department + the set of manageable tool ids. A parent
  // inventory refresh re-supplies an equivalent `items` array with a new reference;
  // keying the load on the array would reshow the skeleton on every toggle.
  const manageableKey = useMemo(
    () => `${department.id}|${manageableItems.map(item => item.tool.toolId).join(',')}`,
    [department.id, manageableItems],
  )

  // Read the latest department/items inside `load` without making them its deps,
  // so an equivalent-but-new reference does not rebuild the callback and reload.
  const departmentRef = useRef(department)
  departmentRef.current = department
  const manageableItemsRef = useRef(manageableItems)
  manageableItemsRef.current = manageableItems

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current
    setLoading(true)
    const activeDepartment = departmentRef.current
    const results = await Promise.allSettled(manageableItemsRef.current.map(async item => {
      const snapshot = await getDivoToolManageSnapshot(item.tool.toolId, { kind: 'department', department: activeDepartment })
      if (snapshot.scope.kind !== 'department') throw new Error('Expected department access snapshot')
      return [item.tool.toolId, snapshot as DepartmentToolManageSnapshot] as const
    }))
    if (requestGeneration.current !== generation) return
    setSnapshots(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])))
    setFailedCount(results.filter(result => result.status === 'rejected').length)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    const mountedGeneration = requestGeneration.current
    return () => {
      if (requestGeneration.current === mountedGeneration) requestGeneration.current = mountedGeneration + 1
    }
    // Reload only when the department or the manageable tool set changes.
  }, [load, manageableKey])

  const rows = useMemo(() => manageableItems.flatMap(item => {
    const snapshot = snapshots[item.tool.toolId]
    return snapshot ? snapshot.supportedActions.map(actionGroup => ({ item, snapshot, actionGroup })) : []
  }).filter(row => !query || `${row.item.tool.name} ${row.item.tool.category} ${row.actionGroup}`.toLocaleLowerCase().includes(query)), [manageableItems, query, snapshots])

  const update = async (snapshot: DepartmentToolManageSnapshot, roleId: string, actionGroup: string, allowed: boolean) => {
    const key = `${snapshot.tool.toolId}:${roleId}:${actionGroup}`
    setSaving(key)
    try {
      const next = await setDivoDepartmentRoleToolAction(snapshot.tool.toolId, department.id, roleId, actionGroup, allowed)
      setSnapshots(current => ({ ...current, [snapshot.tool.toolId]: next }))
      onUpdated()
      toast.success('Role access updated')
    } catch (error) {
      toast.error('Could not update role access', { description: String(error) })
      await load()
    } finally {
      setSaving(null)
    }
  }

  if (!manageableItems.length) return <MatrixState title="No department-managed tools" description={`Divo did not return any tools that ${department.name} managers can configure.`} />
  if (loading) return <Card className="border-border/70 bg-card/30 shadow-none"><CardHeader><CardTitle className="text-base">Loading access map</CardTitle><CardDescription>Checking each tool against current Divo policy.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{[0, 1, 2, 3].map(item => <Skeleton className="h-10 w-full" key={item} />)}</CardContent></Card>

  return (
    <div className="flex flex-col gap-3">
      {failedCount > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Some tool policies could not be loaded</AlertTitle>
          <AlertDescription>{failedCount} tool {failedCount === 1 ? 'snapshot is' : 'snapshots are'} missing from this map. <Button variant="link" size="sm" onClick={() => void load()}><RefreshCw data-icon="inline-start" />Retry</Button></AlertDescription>
        </Alert>
      ) : null}
      <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none">
        <CardHeader className="gap-1 border-b p-4">
          <CardTitle className="text-base">Role-to-tool access</CardTitle>
          <CardDescription>Configured department defaults. Company policy may still reduce effective member access.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-56">Tool capability</TableHead>
                {roles.map(role => <TableHead className="min-w-32 text-center" key={role.id}>{role.name}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? rows.map(({ item, snapshot, actionGroup }) => (
                <TableRow key={`${item.tool.toolId}:${actionGroup}`}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{item.tool.name}</span>
                      <span className="text-xs capitalize text-muted-foreground">{actionGroup}</span>
                    </div>
                  </TableCell>
                  {roles.map(role => {
                    const state = snapshot.roleActionStates.find(action => action.roleId === role.id && action.actionGroup === actionGroup)
                    const key = `${snapshot.tool.toolId}:${role.id}:${actionGroup}`
                    if (!state) return <TableCell className="text-center text-xs text-muted-foreground" key={role.id}>Not supported</TableCell>
                    const blocked = state.companyPolicyStatus === 'company_tool_blocks_all_current_members' || state.companyPolicyStatus === 'company_action_blocks_all_current_members'
                    return (
                      <TableCell className="text-center" key={role.id}>
                        <div className="flex items-center justify-center gap-2" title={policyExplanation(state.companyPolicyStatus)}>
                          <Switch aria-label={`${role.name} ${item.tool.name} ${actionGroup}`} checked={state.configuredAllowed} loading={saving === key} disabled={saving !== null} onCheckedChange={allowed => void update(snapshot, role.id, actionGroup, allowed)} />
                          {blocked ? <Badge variant="outline">Limited</Badge> : null}
                        </div>
                      </TableCell>
                    )
                  })}
                </TableRow>
              )) : <TableRow><TableCell colSpan={roles.length + 1} className="h-28 text-center text-muted-foreground">No tool capabilities match this search.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function MatrixState({ title, description }: { title: string; description: string }) {
  return <Card className="border-dashed bg-card/20 shadow-none"><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card>
}

function policyExplanation(status: DepartmentToolManageSnapshot['roleActionStates'][number]['companyPolicyStatus']): string {
  if (status === 'no_active_members') return 'This rule applies to future members, subject to company policy.'
  if (status === 'company_tool_blocks_all_current_members') return 'Company tool policy blocks all current members in this role.'
  if (status === 'company_action_blocks_all_current_members') return 'Company action policy blocks all current members in this role.'
  return 'Company policy allows at least some current members in this role.'
}
